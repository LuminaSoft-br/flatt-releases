import { spawn } from "node:child_process";

export function cleanBuildEnvironment(environment = process.env) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) =>
        !/(?:^|_)(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY)(?:_|$)/i.test(key) &&
        !/^GITHUB_(?:ENV|OUTPUT|PATH|STATE|STEP_SUMMARY)$/i.test(key) &&
        !/^ACTIONS_(?:RUNTIME|RESULTS|ID_TOKEN)/i.test(key),
    ),
  );
}

export async function runPrivateCommand(stage, command, args, options = {}) {
  if (!/^[a-z-]+$/.test(stage)) throw new Error("Invalid private stage");
  const report = options.report ?? console.log;
  report(`[private-build] ${stage}: started`);
  try {
    await new Promise((accept, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...cleanBuildEnvironment(options.environment), ...options.extraEnv },
        shell: process.platform === "win32" && command === "pnpm",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      // 修复依据：公开 runner 的编译错误也可能含私有源码；排空并丢弃两条输出，不能只屏蔽 token。
      child.stdout.resume();
      child.stderr.resume();
      const heartbeat = setInterval(() => report(`[private-build] ${stage}: running`), 45000);
      heartbeat.unref();
      child.once("error", () => {
        clearInterval(heartbeat);
        reject(new Error(`Private stage ${stage} failed to start`));
      });
      child.once("close", (code) => {
        clearInterval(heartbeat);
        if (code === 0) accept();
        else
          reject(
            new Error(
              `Private stage ${stage} failed (exit ${Number.isInteger(code) ? code : "signal"})`,
            ),
          );
      });
    });
    report(`[private-build] ${stage}: completed`);
  } catch (error) {
    report(`[private-build] ${stage}: failed`);
    throw error;
  }
}
