/**
 * Run the same npm CLI that launched the current package script. Invoking
 * `npm.cmd` directly through child_process is unreliable on recent Windows
 * Node releases, while npm_execpath is stable across npm installations.
 */
export function npmCli(args) {
  const cli = process.env.npm_execpath;
  if (!cli) {
    throw new Error(
      "npm_execpath is unavailable; run this through an npm script",
    );
  }
  return [process.execPath, [cli, ...args]];
}
