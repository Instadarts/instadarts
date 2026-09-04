// The cross-platform development entry point. An npm script that assigns DEV_CLIENT inline works in
// a POSIX shell but not in Windows Command Prompt; doing it here keeps `npm run dev` portable
// without a runtime dependency whose only job is setting one variable. `start.ts` is its sibling.
//
// The import below must stay dynamic. `env.ts` reads DEV_CLIENT once, while it is being evaluated,
// and a static import would be hoisted above the assignment — leaving `npm run dev` a run that
// mounts no client and answers 404 to everything but `/server-stats`, without saying so.

process.env.DEV_CLIENT = '1';
await import('./index');

export {};
