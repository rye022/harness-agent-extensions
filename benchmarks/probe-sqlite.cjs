const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(':memory:');
console.log('node', process.version);
console.log('sqlite version', db.prepare('select sqlite_version() v').get().v);
try { db.exec('create virtual table t using fts5(x)'); console.log('fts5: yes'); } catch (e) { console.log('fts5: no ->', e.message); }
try { db.exec("create virtual table t2 using fts5(x, tokenize='trigram')"); console.log('trigram: yes'); } catch (e) { console.log('trigram: no ->', e.message); }
try { db.exec("create virtual table t3 using fts5(x, tokenize='porter unicode61')"); console.log('porter-unicode61: yes'); } catch (e) { console.log('porter-unicode61: no ->', e.message); }
try { db.exec('create virtual table t4 using fts5(body, tokenize=\'unicode61\')'); console.log('unicode61: yes'); } catch (e) { console.log('unicode61 err', e.message); }
