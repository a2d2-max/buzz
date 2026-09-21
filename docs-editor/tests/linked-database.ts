import { mountEditor } from "../src/editor";
const host = document.querySelector<HTMLElement>("#editor")!;
const id = "11111111-2222-4333-8444-555555555555";
const other = "21111111-2222-4333-8444-555555555555";
const results: string[] = [];
function check(value: unknown, label: string) { if (!value) throw Error(label); results.push(label); }
function rejects(action: () => void, label: string) { let failed=false; try {action();} catch {failed=true;} check(failed,label); }
let editor: Awaited<ReturnType<typeof mountEditor>> | undefined;
try {
  editor=await mountEditor(host,{id:crypto.randomUUID(),title:"Adapter regression",body:`:::db ${id} table\n**Bold explanation** and [link](https://example.test)`},()=>{});
  let block=editor.store.root!.children.flatMap(note=>note.children).find(block=>block.flavour==="a2d2:linked-database");
  check(block,"real MarkdownAdapter imports leading database with formatted tail");
  const first=await editor.snapshot();
  check(first.body.includes("**Bold explanation**")&&first.body.includes("https://example.test"),"MarkdownAdapter preserves following formatting");
  rejects(()=>editor!.selectDatabaseView(block!.id,{databaseId:other,viewId:"board"}),"database identity replacement is rejected");
  editor.selectDatabaseView(block!.id,{databaseId:id,viewId:"board"});
  const saved=await editor.snapshot();
  check(saved.body.includes(`:::db ${id} board`),"selected view reaches Markdown snapshot");
  editor.dispose();
  editor=await mountEditor(host,{id:crypto.randomUUID(),...saved},()=>{});
  block=editor.store.root!.children.flatMap(note=>note.children).find(block=>block.flavour==="a2d2:linked-database");
  check(block?.props.viewId==="board","selected view survives structured snapshot reopen");
  editor.store.deleteBlock(block!);
  rejects(()=>editor!.selectDatabaseView(block!.id,{databaseId:id,viewId:"table"}),"deleted block view update is rejected");
  document.querySelector("#result")!.textContent=JSON.stringify({ok:true,results},null,2);
} catch(error) {
  document.querySelector("#result")!.textContent=JSON.stringify({ok:false,results,error:String(error)},null,2);
} finally { editor?.dispose(); }
