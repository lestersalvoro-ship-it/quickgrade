/** Maintenance commands: `migrate`, `retention`, `backup <file>`. */
import { loadConfig } from './config';
import { migrate, openDatabase } from './db/index';
import { ScanStorage, applyRetention } from './services/support';

const [cmd, arg] = process.argv.slice(2);
const config = loadConfig();
const db = openDatabase(config.databaseFile);

switch (cmd) {
  case 'migrate': {
    const ran = migrate(db, console.log);
    console.log(ran.length ? `Applied ${ran.length} migration(s).` : 'Database is up to date.');
    break;
  }
  case 'retention': {
    migrate(db);
    const n = applyRetention(db, new ScanStorage(config.uploadsDir));
    console.log(`Removed images for ${n} scan(s).`);
    break;
  }
  case 'backup': {
    if (!arg) {
      console.error('Usage: cli backup <destination.db>');
      process.exit(1);
    }
    await db.backup(arg);
    console.log(`Online backup written to ${arg}`);
    break;
  }
  default:
    console.error('Commands: migrate | retention | backup <file>');
    process.exit(1);
}
db.close();
