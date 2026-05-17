declare module 'electron-squirrel-startup' {
  const handled: boolean;
  export default handled;
}

// Vite ?raw import — inlines the file's text content as a string at build
// time. Used in src/main/signatures/trust.ts for the Mozilla CA bundle.
declare module '*.pem?raw' {
  const content: string;
  export default content;
}
