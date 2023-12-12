import type { getValidatedArgs } from './get-validated-args'

export type CliCommand = (args: ReturnType<typeof getValidatedArgs>) => void

/**
 * 下面是所有命令
 * 执行命令调用对应的脚本文件
 * 查看具体命令执行逻辑，需要前往对应的脚本路径
 *
 * 下边 import 为快捷跳转
 */

// import '../cli/next-build'
export const commands: { [command: string]: () => Promise<CliCommand> } = {
  // 已完成
  build: () => Promise.resolve(require('../cli/next-build').nextBuild),
  // 进行中
  start: () => Promise.resolve(require('../cli/next-start').nextStart),
  // 暂未开始
  export: () => Promise.resolve(require('../cli/next-export').nextExport),
  // 进行中
  dev: () => Promise.resolve(require('../cli/next-dev').nextDev),
  // 暂未开始
  lint: () => Promise.resolve(require('../cli/next-lint').nextLint),
  // 暂未开始
  telemetry: () =>
    Promise.resolve(require('../cli/next-telemetry').nextTelemetry),
  info: () => Promise.resolve(require('../cli/next-info').nextInfo),
  'experimental-compile': () =>
    Promise.resolve(require('../cli/next-build').nextBuild),
  'experimental-generate': () =>
    Promise.resolve(require('../cli/next-build').nextBuild),
}
