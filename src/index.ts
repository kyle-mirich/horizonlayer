import { runServer } from './runServer.js';

async function main(): Promise<void> {
  await runServer();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
