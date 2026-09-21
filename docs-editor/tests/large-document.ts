import { mountEditor } from "../src/editor";
import { createAsyncRecoveryJournal } from "../src/asyncRecoveryJournal";
import { readRecovery, removeRecovery } from "../src/recoveryStorage";
const host = document.querySelector<HTMLElement>("#editor")!;
const results: string[] = [];
function check(value: unknown, label: string) {
  if (!value) throw Error(label);
  results.push(label);
}
let editor: Awaited<ReturnType<typeof mountEditor>> | undefined;
const key = "buzz.docs.affine-backup.v1.large-fixture";
try {
  const text = "Large document 한글 restoration. ".repeat(12000);
  editor = await mountEditor(
    host,
    { id: crypto.randomUUID(), title: "Large storage fixture", body: text },
    () => {},
  );
  const asset = new Uint8Array(1024 * 1024);
  crypto.getRandomValues(asset.subarray(0, 65536));
  await editor.workspace.blobs.set(
    "fixture-attachment",
    new Blob([asset], { type: "application/octet-stream" }),
  );
  const draft = await editor.snapshot();
  check(
    draft.affine.data.length > 262144,
    "real editor snapshot exceeds old 256 KiB envelope",
  );
  const journal = createAsyncRecoveryJournal(key, "fixture");
  await journal.record(draft);
  const restored = JSON.parse((await readRecovery(key))!);
  check(
    restored.affine.data === draft.affine.data,
    "IndexedDB retains multi-megabyte draft before publication",
  );
  editor.dispose();
  editor = await mountEditor(
    host,
    { id: crypto.randomUUID(), ...restored },
    () => {},
  );
  const reopened = await editor.snapshot();
  check(
    reopened.body.includes(text.trim()),
    "new editor runtime restores complete large text",
  );
  const blob = await editor.workspace.blobs.get("fixture-attachment");
  check(
    blob &&
      new Uint8Array(await blob.arrayBuffer()).every((v, i) => v === asset[i]),
    "new editor runtime restores exact attachment bytes",
  );
  const notionFixture = await (await fetch("/notion-fixture.json")).json();
  editor.dispose();
  editor = await mountEditor(host, notionFixture, () => {});
  const paragraph = editor.store.getBlock(
    "11111111-1111-4111-8111-111111111111",
  )!.model;
  (
    paragraph.props as {
      text: { insert: (text: string, index: number) => void };
    }
  ).text.insert(" edited", 8);
  const notionSaved = await editor.snapshot();
  (window as unknown as { notionEdited: unknown }).notionEdited = notionSaved;
  check(
    notionSaved.body.includes("Original edited"),
    "Notion structured import renders and edits in real BlockSuite",
  );
  await journal.acknowledge(journal.revision, draft.affine.data);
  check(
    (await readRecovery(key)) === null,
    "only matching saved revision clears durable recovery",
  );
  document.querySelector("#result")!.textContent = JSON.stringify(
    { ok: true, results, bytes: draft.affine.data.length },
    null,
    2,
  );
} catch (error) {
  document.querySelector("#result")!.textContent = JSON.stringify(
    { ok: false, results, error: String(error) },
    null,
    2,
  );
} finally {
  editor?.dispose();
  await removeRecovery(key);
}
