import type { ComposerInitialConfig } from "@/store/zcodeSessionStoreTypes.js";
import type { ModelSelectionView } from "@zcode/services";
import { readComposerRecent, resolveDraftInitialModelSelection } from "@/lib/composerRecent.js";
import {
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
  type V4ComposerDraft,
  type ComposerScope,
  resolveComposerScope,
  readComposerWorkspaceScope,
} from "@/v4/composer/composerDraftStore.js";

/**
 * zcode-go 新任务草稿的「自动勾上」兜底：preferredSelection 缺失（全新环境无偏好记录，
 * 或 Registry 对全部模型给不出 reasoning 档位）时，按 View 顺序取第一个有模型
 * 的 provider 的第一个模型。只用于新任务草稿——会话快照的空选择是确定结果，
 * 绝不进入本兜底。选择不带 options（与用户手动选模同形），档位由控件自行呈现。
 */
export function pickFirstAvailableDraftModelSelection(
  view: ModelSelectionView,
): { providerId: string; modelId: string } | undefined {
  for (const provider of view.providers) {
    const model = provider.models[0];
    if (model) return { providerId: provider.providerId, modelId: model.modelId };
  }
  return undefined;
}

/** 普通新任务与首次分享导入共用初始化；保留 Recent 原意图，由公共 View 解析有效选择。 */
export function initializeNewTaskDraft(
  draft: V4ComposerDraft,
  workspacePath: string,
  workspaceIdentity: string | undefined,
  view: ModelSelectionView,
  scope?: ComposerScope,
): V4ComposerDraft {
  const recent = readComposerRecent(workspacePath, workspaceIdentity, undefined, scope);
  return {
    ...draft,
    mode: recent?.mode === "plan" ? "build" : (recent?.mode ?? "build"),
    planEnabled: false,
    modelSelection:
      recent?.modelSelection ??
      resolveDraftInitialModelSelection(view, null).selection ??
      pickFirstAvailableDraftModelSelection(view) ??
      undefined,
  };
}

/** 首次导入由导航动作显式传参；复用历史或已有文字草稿不覆盖。 */
export function resolveImportedComposerConfig(
  result: {
    workspacePath: string;
    workspaceIdentity?: string;
    sessionId: string;
    reused: boolean;
  },
  clientNamespace = "desktop",
): ComposerInitialConfig | undefined {
  const { workspacePath, workspaceIdentity, sessionId, reused } = result;
  if (reused || readV4ComposerDraft(workspacePath, workspaceIdentity, sessionId)) return undefined;
  const scope =
    readComposerWorkspaceScope(workspacePath, workspaceIdentity, clientNamespace) ??
    resolveComposerScope(null, workspaceIdentity, clientNamespace);
  const root = readV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT, scope);
  return root?.mode
    ? {
        mode: root.mode,
        planEnabled: root.planEnabled ?? false,
        modelSelection: root.modelSelection,
      }
    : {};
}
