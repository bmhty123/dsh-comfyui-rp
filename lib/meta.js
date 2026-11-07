/**
 * 全插件共用的标识常量。
 *
 * ★ 客户端半区（lib/client.js）是独立 bundle，不能 import 这个文件，
 *   所以那边有一份同值常量（ROUTE / TAB_ID / TAB_KIND）。改路由时两边都要改。
 */
export const PACKAGE_NAME = 'dsh-comfyui-rp';
export const PLUGIN_NAME = 'dsh-comfyui-rp';
export const VERSION = '0.2.6';

/** 对外路由前缀。不能带尾斜杠（dsh-host-webserver 的 prefix 匹配规则）。 */
export const ROUTE_PATH = '/__airp_comfy';

/** 内部面板标识（日志 / 旧数据兼容用）；右侧栏标签类型由客户端注册为 `airp`。 */
export const PANEL_ID = 'airp-comfy';

/** 右侧栏标签 / 开始菜单卡片用的短名。 */
export const PANEL_LABEL = 'ComfyRP';
export const PANEL_TITLE = 'ComfyRP Bridge × ComfyUI 生图桥';

/** 默认数据目录（DSH home 下），可用环境变量 AIRP_COMFY_DATA 覆盖。 */
export const DEFAULT_DATA_DIR = '.dsh/airp-comfy';
