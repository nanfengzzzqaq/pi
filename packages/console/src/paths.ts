/**
 * 数据目录的唯一出口。
 *
 * 默认 <包>/data（开发模式）；安装版通过环境变量 PI_CONSOLE_DATA
 * 外置到 %APPDATA%\pi-console\data（由启动器设置），卸载/重装不丢数据。
 */
import { join } from "node:path";

export const PACKAGE_ROOT = join(import.meta.dirname, "..");

export const DATA_DIR = process.env.PI_CONSOLE_DATA ?? join(PACKAGE_ROOT, "data");
