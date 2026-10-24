import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { TabBar } = await jiti.import("./TabBar.tsx");

function renderTabBar(count) {
  const tabs = Array.from({ length: count }, (_, index) => ({ id: `t${index}`, label: `file-${index}.ts`, filePath: `/p/file-${index}.ts` }));
  return renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(TabBar, { tabs, activeTabId: "t0", onSelectTab() {}, onCloseTab() {} })));
}

/** The inline style of every element with that role, as property maps. */
function styles(html, role) {
  return [...html.matchAll(new RegExp(`<div role="${role}"[^>]* style="([^"]*)"`, "g"))].map(([, style]) =>
    Object.fromEntries(style.split(";").filter(Boolean).map((declaration) => {
      const colon = declaration.indexOf(":");
      return [declaration.slice(0, colon), declaration.slice(colon + 1)];
    })));
}

test("overflowing tabs keep the whole 36px bar: the strip has no scrollbar", () => {
  // The app's 10px (6px on touch) scrollbar took its height out of the 36px
  // bar: 36px tabs were clipped (#1225), stretched ones squeezed to 26px.
  const html = renderTabBar(12);
  assert.match(html, /<div role="tablist" class="tabbar-scroll"/);
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.tabbar-scroll \{\s*scrollbar-width: none;\s*\}/);
  assert.match(css, /\.tabbar-scroll::-webkit-scrollbar \{\s*display: none;\s*\}/);
  const [list] = styles(html, "tablist");
  assert.equal(list.height, "36px");
  assert.equal(list["overflow-x"], "auto");
  assert.equal(list["overflow-y"], "hidden");
  assert.equal(list["align-items"], "stretch");
  const tabs = styles(html, "tab");
  assert.equal(tabs.length, 12);
  for (const tab of tabs) {
    assert.equal(tab.height, undefined);
    assert.equal(tab["align-items"], "center");
  }
});

test("the pinned pull request tab has no close button and keeps its icon", () => {
  const tabs = [
    { id: "prs", label: "PRs", filePath: "PRs", kind: "prs", pinned: true },
    { id: "file:1", label: "app.ts", filePath: "/p/app.ts" },
  ];
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(TabBar, { tabs, activeTabId: "prs", onSelectTab() {}, onCloseTab() {} })));
  // Only the file tab offers a close button; the pinned one never does.
  const closeLabels = [...html.matchAll(/aria-label="Close ([^"]*)"/g)].map((match) => match[1]);
  assert.deepEqual(closeLabels, ["app.ts"]);
  const pinnedTab = html.slice(html.indexOf('role="tab" aria-label="PRs"'), html.indexOf('role="tab" aria-label="app.ts"'));
  assert.ok(pinnedTab.length > 0, "the pinned tab renders first");
  assert.match(pinnedTab, /<svg/, "the pinned tab keeps an icon");
  assert.equal(pinnedTab.includes("<button"), false, "no close button inside the pinned tab");
});
