import assert from "node:assert/strict";
import { test } from "node:test";
import { directive, upgradeLinkedDatabaseBlocks } from "./linkedDatabaseReference.ts";
const id = "11111111-2222-4333-8444-555555555555";
const paragraph = (text, flavour = "affine:paragraph") => ({ id: "old", flavour, props: { type: "text", text: { delta: [{ insert: text }] } }, children: [] });
const page = (...blocks) => ({ id: "page", flavour: "affine:page", props: {}, children: [{ id: "note", flavour: "affine:note", props: {}, children: blocks }] });
test("import preserves ordered multiple DB references and following text", () => {
 const root = page(paragraph(`:::db ${id} table\n:::db ${id} board\nAfter`));
 let sequence = 0;
 upgradeLinkedDatabaseBlocks(root, () => `block-${++sequence}`);
 const blocks = root.children[0].children;
 assert.deepEqual(blocks.slice(0, 2).map(block => block.props), [{databaseId:id,viewId:"table"},{databaseId:id,viewId:"board"}]);
 assert.equal(blocks[2].props.text.delta[0].insert, "After");
 assert.equal(new Set(blocks.map(block => block.id)).size, 3);
});
test("code, heading, formatted and non-leading examples do not become live databases", () => {
 const blocks = [paragraph(`:::db ${id}`, "affine:code"), paragraph(`Example\n:::db ${id}`), {...paragraph(`:::db ${id}`),props:{type:"h1",text:{delta:[{insert:`:::db ${id}`}]}}}, {...paragraph(`:::db ${id}`),props:{type:"text",text:{delta:[{insert:`:::db ${id}`,attributes:{bold:true}}]}}}];
 const root = page(...blocks);
 upgradeLinkedDatabaseBlocks(root, () => "unused");
 assert.deepEqual(root.children[0].children, blocks);
});
test("only canonical local database and view identifiers are accepted", () => {
 assert.deepEqual(directive(`:::db ${id}`), {databaseId:id,viewId:null});
 for (const line of [` :::db ${id}`, `:::db ${id} a/b`, ":::db https://other/db", `:::db  ${id}`, `:::db ${id} `]) assert.equal(directive(line),null);
});

test("leading reference converts while following rich text keeps its attributes", () => {
 const tail = [{ insert: "Bold description", attributes: { bold: true } }, { insert: " and link", attributes: { link: "https://example.test" } }];
 const block = paragraph("");
 block.props.text.delta = [{ insert: `:::db ${id} table\n` }, ...tail];
 const root = page(block);
 upgradeLinkedDatabaseBlocks(root, () => "linked");
 assert.equal(root.children[0].children[0].flavour, "a2d2:linked-database");
 assert.deepEqual(root.children[0].children[1].props.text.delta, tail);
});
