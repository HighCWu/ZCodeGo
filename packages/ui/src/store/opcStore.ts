/**
 * zcode-go OPC 公司状态（渲染进程投影缓存）。
 *
 * 事实源在 desktop main（<workspace>/.opc/company.json）；本 store 只是投影：
 * 一切变更走 apply() → IPC ZcodeGoOpcApply → main reducer → 返回整树覆盖；
 * main 广播 ZcodeGoOpcStateChanged 时整体 refresh，不做局部 merge（避免双写路径）。
 * 键约定：workspaceIdentity?.trim() || workspacePath（与全局身份键一致）。
 */
import { create } from "zustand";
import {
  findOpcBuiltinRoleDraft,
  type OpcCompanyState,
  type OpcEvolutionEvent,
  type OpcInboxItem,
  type OpcMutation,
} from "@zcode/shared";
import { logger } from "@/logger.js";

export interface OpcBodies {
  roleTemplateBodies: Record<string, string>;
  skillBodies: Record<string, string>;
}

interface OpcApplyOutcome {
  ok: boolean;
  events: OpcEvolutionEvent[];
  promotedSkillIds: string[];
}

interface ZcodeGoOpcBridge {
  zcodeGoOpcGetState?: (payload: { workspacePath: string }) => Promise<{
    ok: boolean;
    state: OpcCompanyState | null;
    inbox?: OpcInboxItem[];
    employeeMemoryIndexes?: Record<string, string | null>;
    roleTemplateBodies?: Record<string, string>;
    skillBodies?: Record<string, string>;
    error?: string;
  }>;
  zcodeGoOpcConsumeInbox?: (payload: {
    workspacePath: string;
    fileName: string;
    convert?: {
      title: string;
      detail?: string;
      priority?: "low" | "medium" | "high" | "urgent";
      assigneeId?: string | null;
    } | null;
  }) => Promise<{
    ok: boolean;
    state: OpcCompanyState | null;
    inbox?: OpcInboxItem[];
    error?: string;
  }>;
  zcodeGoOpcApply?: (payload: {
    workspacePath: string;
    mutations: OpcMutation[];
  }) => Promise<{
    ok: boolean;
    state: OpcCompanyState | null;
    events: OpcEvolutionEvent[];
    promotedSkillIds: string[];
    roleTemplateBodies?: Record<string, string>;
    skillBodies?: Record<string, string>;
    error?: string;
  }>;
  zcodeGoOpcImportRoleTemplates?: (payload: {
    workspacePath: string;
    sourcePath: string;
  }) => Promise<{
    ok: boolean;
    imported: number;
    state: OpcCompanyState | null;
    roleTemplateBodies?: Record<string, string>;
    skillBodies?: Record<string, string>;
    error?: string;
  }>;
  zcodeGoOpcImportSkillFolder?: (payload: {
    workspacePath: string;
    sourcePath: string;
  }) => Promise<{
    ok: boolean;
    imported: number;
    state: OpcCompanyState | null;
    roleTemplateBodies?: Record<string, string>;
    skillBodies?: Record<string, string>;
    error?: string;
  }>;
  zcodeGoOpcReadFingerprintSample?: (payload: {
    workspacePath: string;
    fileName: string;
  }) => Promise<{ ok: boolean; content: string | null; error?: string }>;
  onZcodeGoOpcStateChanged?: (
    handler: (payload: { workspacePath: string }) => void,
  ) => () => void;
}

function getOpcBridge(): ZcodeGoOpcBridge | null {
  const bridge = (
    window as {
      zcode?: ZcodeGoOpcBridge;
    }
  ).zcode;
  if (!bridge?.zcodeGoOpcGetState) return null;
  return bridge;
}

/** 角色正文查找：导入模板正文优先；内置模板回退内置包（正文已去 frontmatter）。 */
function resolveRoleTemplateBody(
  templateId: string,
  bodies: OpcBodies,
): string | null {
  const imported = bodies.roleTemplateBodies[templateId];
  if (imported) return imported;
  return findOpcBuiltinRoleDraft(templateId)?.body ?? null;
}

export interface OpcStoreState {
  workspaceKey: string | null;
  workspacePath: string | null;
  state: OpcCompanyState | null;
  bodies: OpcBodies;
  inbox: OpcInboxItem[];
  /** 员工持久记忆的 MEMORY.md 索引（GetState 时 main 批量绑定并回读） */
  employeeMemoryIndexes: Record<string, string | null>;
  loading: boolean;
  error: string | null;
  /** 最近一次 apply 触发的晋升（UI toast 用，消费后 clearRecentPromotions）。 */
  recentPromotedSkillIds: string[];
  initialize: (
    workspacePath: string,
    workspaceIdentity?: string,
  ) => Promise<void>;
  refresh: () => Promise<void>;
  apply: (mutations: OpcMutation[]) => Promise<OpcApplyOutcome>;
  /** 从磁盘目录导入角色模板（OpenOPC talent 五字段格式）。 */
  importRoleTemplates: (
    sourcePath: string,
  ) => Promise<{ ok: boolean; imported: number }>;
  /** 从磁盘目录导入技能（claude-skills SKILL.md 格式，递归）。 */
  importSkillFolder: (
    sourcePath: string,
  ) => Promise<{ ok: boolean; imported: number }>;
  /** 消费入站队列条目（转工作项或忽略）；main 返回新 state + 剩余 inbox。 */
  consumeInbox: (
    fileName: string,
    convert: {
      title: string;
      detail?: string;
      priority?: "low" | "medium" | "high" | "urgent";
      assigneeId?: string | null;
    } | null,
  ) => Promise<boolean>;
  clearRecentPromotions: () => void;
  /** 供组件按员工模板 id 解角色正文（内置回退逻辑集中在这里）。 */
  resolveRoleBody: (templateId: string) => string | null;
  resolveSkillBody: (skillId: string) => string | null;
}

let opcUnsubscribe: (() => void) | null = null;
let opcInFlight: Promise<void> | null = null;
let opcInFlightKey: string | null = null;

export const useOpcStore = create<OpcStoreState>()((set, get) => ({
  workspaceKey: null,
  workspacePath: null,
  state: null,
  bodies: { roleTemplateBodies: {}, skillBodies: {} },
  inbox: [],
  employeeMemoryIndexes: {},
  loading: false,
  error: null,
  recentPromotedSkillIds: [],

  initialize: async (workspacePath, workspaceIdentity) => {
    const bridge = getOpcBridge();
    const workspaceKey = workspaceIdentity?.trim() || workspacePath;
    if (!bridge) {
      set({ error: "ipc-unavailable", workspaceKey, workspacePath });
      return;
    }
    if (get().workspaceKey === workspaceKey && (get().state || get().loading))
      return;
    // in-flight 绑定工作区键：否则快速切工作区时 initialize(B) 被 A 的
    // 请求吞掉，B 渲染 A 的公司数据
    if (opcInFlight && opcInFlightKey === workspaceKey) return opcInFlight;
    set({ loading: true, error: null });
    opcInFlightKey = workspaceKey;
    opcInFlight = (async () => {
      try {
        const result = await bridge.zcodeGoOpcGetState!({ workspacePath });
        if (!result.ok || !result.state) {
          set({
            loading: false,
            error: result.error ?? "opc-state-unavailable",
            state: null,
            // 失败即清残留：换工作区失败时不能留着上一区的入站条目
            inbox: [],
          employeeMemoryIndexes: {},
            workspaceKey,
            workspacePath,
            bodies: { roleTemplateBodies: {}, skillBodies: {} },
          });
          return;
        }
        set({
          loading: false,
          error: null,
          state: result.state,
          inbox: result.inbox ?? [],
          employeeMemoryIndexes: result.employeeMemoryIndexes ?? {},
          bodies: {
            roleTemplateBodies: result.roleTemplateBodies ?? {},
            skillBodies: result.skillBodies ?? {},
          },
          workspaceKey,
          workspacePath,
        });
        // 状态变化订阅只挂一次；按 workspacePath 过滤，跨工作区广播不误刷。
        if (!opcUnsubscribe) {
          opcUnsubscribe =
            bridge.onZcodeGoOpcStateChanged?.((payload) => {
              const current = get();
              if (
                current.workspacePath &&
                payload.workspacePath === current.workspacePath
              ) {
                void current.refresh();
              }
            }) ?? null;
        }
      } catch (error) {
        logger.warn("[zcode-go][opc] 读取公司状态失败", error);
        set({
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        opcInFlight = null;
        opcInFlightKey = null;
      }
    })();
    return opcInFlight;
  },

  refresh: async () => {
    const { workspacePath, workspaceKey } = get();
    const bridge = getOpcBridge();
    if (!bridge || !workspacePath || !workspaceKey) return;
    try {
      const result = await bridge.zcodeGoOpcGetState!({ workspacePath });
      if (result.ok && result.state) {
        set({
          state: result.state,
          inbox: result.inbox ?? [],
          employeeMemoryIndexes: result.employeeMemoryIndexes ?? {},
          bodies: {
            roleTemplateBodies: result.roleTemplateBodies ?? {},
            skillBodies: result.skillBodies ?? {},
          },
          error: null,
        });
      }
    } catch (error) {
      logger.warn("[zcode-go][opc] 刷新公司状态失败", error);
    }
  },

  /** 消费入站条目（转工作项或忽略）；main 返回新 state + 剩余 inbox。 */
  consumeInbox: async (
    fileName: string,
    convert: {
      title: string;
      detail?: string;
      priority?: "low" | "medium" | "high" | "urgent";
      assigneeId?: string | null;
    } | null,
  ): Promise<boolean> => {
    const bridge = getOpcBridge();
    const { workspacePath } = get();
    if (!bridge?.zcodeGoOpcConsumeInbox || !workspacePath) return false;
    try {
      const result = await bridge.zcodeGoOpcConsumeInbox({
        workspacePath,
        fileName,
        convert,
      });
      if (result.ok && result.state) {
        // 消费只建工作项（不新增技能/模板），bodies 无需刷新
        set({ state: result.state, inbox: result.inbox ?? [] });
      }
      return result.ok;
    } catch (error) {
      logger.warn("[zcode-go][opc] 消费入站条目失败", error);
      return false;
    }
  },

  apply: async (mutations) => {
    const { workspacePath } = get();
    const bridge = getOpcBridge();
    if (!bridge || !workspacePath || mutations.length === 0) {
      return { ok: false, events: [], promotedSkillIds: [] };
    }
    try {
      const result = await bridge.zcodeGoOpcApply!({
        workspacePath,
        mutations,
      });
      if (result.ok && result.state) {
        set({
          state: result.state,
          bodies: {
            roleTemplateBodies: result.roleTemplateBodies ?? {},
            skillBodies: result.skillBodies ?? {},
          },
          error: null,
          recentPromotedSkillIds: result.promotedSkillIds,
        });
      }
      if (!result.ok) {
        set({ error: result.error ?? "opc-apply-rejected" });
      }
      return {
        ok: result.ok,
        events: result.events ?? [],
        promotedSkillIds: result.promotedSkillIds ?? [],
      };
    } catch (error) {
      logger.warn("[zcode-go][opc] 应用变更失败", error);
      // 失败必须可见：对话框会照常关闭，静默吞掉=用户以为已保存
      set({
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, events: [], promotedSkillIds: [] };
    }
  },

  clearRecentPromotions: () => set({ recentPromotedSkillIds: [] }),

  importRoleTemplates: async (sourcePath) => {
    const bridge = getOpcBridge();
    const { workspacePath } = get();
    if (!bridge?.zcodeGoOpcImportRoleTemplates || !workspacePath) {
      return { ok: false, imported: 0 };
    }
    try {
      const result = await bridge.zcodeGoOpcImportRoleTemplates({
        workspacePath,
        sourcePath,
      });
      if (result.ok && result.state) {
        set({
          state: result.state,
          bodies: {
            roleTemplateBodies: result.roleTemplateBodies ?? {},
            skillBodies: result.skillBodies ?? {},
          },
        });
      }
      return { ok: result.ok, imported: result.imported };
    } catch (error) {
      logger.warn("[zcode-go][opc] 导入角色模板失败", error);
      return { ok: false, imported: 0 };
    }
  },

  importSkillFolder: async (sourcePath) => {
    const bridge = getOpcBridge();
    const { workspacePath } = get();
    if (!bridge?.zcodeGoOpcImportSkillFolder || !workspacePath) {
      return { ok: false, imported: 0 };
    }
    try {
      const result = await bridge.zcodeGoOpcImportSkillFolder({
        workspacePath,
        sourcePath,
      });
      if (result.ok && result.state) {
        set({
          state: result.state,
          bodies: {
            roleTemplateBodies: result.roleTemplateBodies ?? {},
            skillBodies: result.skillBodies ?? {},
          },
        });
      }
      return { ok: result.ok, imported: result.imported };
    } catch (error) {
      logger.warn("[zcode-go][opc] 导入技能目录失败", error);
      return { ok: false, imported: 0 };
    }
  },

  resolveRoleBody: (templateId) =>
    resolveRoleTemplateBody(templateId, get().bodies),
  resolveSkillBody: (skillId) => get().bodies.skillBodies[skillId] ?? null,
}));
