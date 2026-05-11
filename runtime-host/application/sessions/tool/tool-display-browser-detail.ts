import {
  asRecord,
  joinDetailParts,
  previewText,
  quoteText,
  resolveArrayPreview,
} from './tool-display-format';

function resolveBrowserActKindLabel(kind: string | undefined): string | undefined {
  switch (kind) {
    case 'click':
      return '点击';
    case 'dblclick':
      return '双击';
    case 'hover':
      return '悬停';
    case 'focus':
      return '聚焦';
    case 'type':
      return '输入';
    case 'fill':
      return '填写';
    case 'select':
    case 'select_option':
      return '选择';
    case 'press':
      return '按键';
    case 'scroll':
      return '滚动';
    case 'wait':
      return '等待';
    case 'assert':
      return '校验';
    default:
      return kind ? kind.replace(/_/g, ' ') : undefined;
  }
}

export function resolveBrowserDetail(action: string | undefined, args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record || !action) {
    return undefined;
  }
  const targetUrl = (
    typeof record.targetUrl === 'string' && record.targetUrl.trim()
      ? record.targetUrl.trim()
      : (typeof record.url === 'string' && record.url.trim() ? record.url.trim() : undefined)
  );
  const targetId = typeof record.targetId === 'string' ? record.targetId.trim() : undefined;
  const format = typeof record.format === 'string' ? record.format.trim() : undefined;
  const level = typeof record.level === 'string' ? record.level.trim() : undefined;
  const promptText = typeof record.promptText === 'string' ? record.promptText.trim() : undefined;
  const uploadPaths = resolveArrayPreview(record.paths, { maxArrayEntries: 2, maxStringChars: 36 });
  const ref = typeof record.ref === 'string' ? record.ref.trim() : undefined;
  const inputRef = typeof record.inputRef === 'string' ? record.inputRef.trim() : undefined;
  const element = typeof record.element === 'string' ? record.element.trim() : undefined;
  const request = asRecord(record.request);

  switch (action) {
    case 'status':
      return targetId ? `查看浏览器状态 · ${targetId}` : '查看浏览器状态';
    case 'start':
      return '启动浏览器';
    case 'stop':
      return '关闭浏览器';
    case 'tabs':
      return '查看已打开标签页';
    case 'open':
      return targetUrl ? `打开网页 ${targetUrl}` : '打开网页';
    case 'navigate':
      return targetUrl ? `前往 ${targetUrl}` : (targetId ? `切换到 ${targetId}` : '页面跳转');
    case 'focus':
      return targetId ? `切换到 ${targetId}` : '切换标签页';
    case 'close':
      return targetId ? `关闭 ${targetId}` : '关闭标签页';
    case 'snapshot':
      return targetUrl
        ? `提取页面内容 · ${targetUrl}${format ? ` · ${format}` : ''}`
        : (targetId ? `提取页面内容 · ${targetId}${format ? ` · ${format}` : ''}` : '提取页面内容');
    case 'screenshot':
      return targetUrl ? `截取页面画面 · ${targetUrl}` : (targetId ? `截取页面画面 · ${targetId}` : '截取页面画面');
    case 'console':
      return level ? `查看控制台 · ${level}` : (targetId ? `查看控制台 · ${targetId}` : '查看控制台');
    case 'pdf':
      return targetId ? `导出 PDF · ${targetId}` : '导出 PDF';
    case 'upload':
      return joinDetailParts([
        targetId ? `上传文件到 ${targetId}` : '上传文件',
        uploadPaths,
        ref ? `定位 ${ref}` : undefined,
        inputRef ? `输入框 ${inputRef}` : undefined,
        element ? `元素 ${element}` : undefined,
      ]);
    case 'dialog':
      return joinDetailParts([
        typeof record.accept === 'boolean'
          ? (record.accept ? '确认弹窗' : '取消弹窗')
          : '处理弹窗',
        promptText ? `内容 ${previewText(promptText, 36)}` : undefined,
        targetId ? `来源 ${targetId}` : undefined,
      ]);
    case 'act': {
      const kind = typeof request?.kind === 'string' ? request.kind.trim() : undefined;
      const ref = typeof request?.ref === 'string' ? request.ref.trim() : undefined;
      const selector = typeof request?.selector === 'string' ? request.selector.trim() : undefined;
      const value = typeof request?.value === 'string' ? request.value.trim() : undefined;
      const text = typeof request?.text === 'string' ? request.text.trim() : undefined;
      const target = ref || selector || quoteText(text) || previewText(value, 28);
      const kindLabel = resolveBrowserActKindLabel(kind);
      return joinDetailParts([
        kindLabel ? `${kindLabel}页面元素` : '页面交互',
        target,
        targetId ? `标签页 ${targetId}` : undefined,
      ]);
    }
    default:
      return undefined;
  }
}
