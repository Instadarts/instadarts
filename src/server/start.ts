// The cross-platform production entry point. An npm script that assigns NODE_ENV inline works in a
// POSIX shell but not in Windows Command Prompt; doing it here keeps `npm start` portable without a
// runtime dependency whose only job is setting one variable.
//
// The import below must stay dynamic. `env.ts` reads NODE_ENV once, while it is being evaluated,
// and a static import would be hoisted above the assignment — leaving `npm start` a development
// run that sets no CLIENT_DIR and therefore serves no client at all, without saying so.

process.env.NODE_ENV = 'production';
await import('./index');

export {};
