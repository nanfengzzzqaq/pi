/**
 * 数据目录的唯一出口。
 *
 * 默认 <包>/data（开发模式）；安装版通过环境变量 PI_CONSOLE_DATA
 * 外置到 %APPDATA%\pi-console\data（由启动器设置），卸载/重装不丢数据。
 */
import { dirname, join } from "node:path";

export const PACKAGE_ROOT = join(import.meta.dirname, "..");

export const DATA_DIR = process.env.PI_CONSOLE_DATA ?? join(PACKAGE_ROOT, "data");

/**
 * 数据位置指针必须放在数据目录外，否则迁移后下次启动无法找到新位置。
 * Electron 启动器会显式传入位于 %APPDATA%\\pi-console 下的稳定路径。
 */
export const STORAGE_CONFIG_FILE =
	process.env.PI_CONSOLE_STORAGE_CONFIG ?? join(dirname(DATA_DIR), "storage-location.json");
