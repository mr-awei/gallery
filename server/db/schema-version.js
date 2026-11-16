/**
 * 库结构的单调版本号，必须等于 db/migrate.js 里 MIGRATIONS.length。
 *
 * 单独放一个只含常量的文件：主进程做热更闸门（热更包能不能装）时要读它，
 * 但绝不能因此把 node:sqlite、迁移、reconcile 整条依赖链拉进主进程。
 * migrate.js 里有一致性断言，两边不同步会立刻炸在启动阶段，不会被悄悄放过。
 */
export const SCHEMA_VERSION = 4;
