import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openStore} from '../store.mjs';
import {createWorkspaceService} from '../workspace.mjs';

test('a source base without a book can be selected without inventing a book',async t=>{
  const root=await mkdtemp(join(tmpdir(),'tw-series-only-')),vault=join(root,'vault'),series=join(vault,'00 Автор','Fixture Author','Fixture Series');
  await mkdir(series,{recursive:true});await writeFile(join(series,'00 Паспорт серии.md'),'---\ntitle: Fixture Series\n---\n# Fixture Series\n');
  await writeFile(join(series,'Заметка.md'),'# Source note\nA source-bound note.\n');
  const store=openStore(join(root,'data'));t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const workspace=createWorkspaceService({catalogVaultPath:vault,initialVaultPath:vault,dataDir:join(root,'data'),store});
  const author=workspace.catalog().authors[0],item=author.series[0];assert.deepEqual(item.books,[]);
  await workspace.select({authorId:author.id,seriesId:item.id,bookId:null});
  assert.equal(workspace.selection().bookId,null);assert.equal(workspace.root(),series);
  assert.equal(workspace.cards({}).cards.length,2);assert.equal((await workspace.overview()).active.bookId,null);
  await assert.rejects(workspace.select({authorId:author.id,seriesId:item.id,bookId:'invented'}),/catalog/);
});
