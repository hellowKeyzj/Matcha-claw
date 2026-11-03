import type { DesignDocument, GenerationRequest, ImageLayer } from './document';

type ComposeAttachment = {
  /** 生成时读取的插件图片资产 ID。 */
  assetId: string;
  /** 暂存到对话的附件名。 */
  attachmentName: string;
  /** 本组附件索引，从 0 开始；减图后重排，与模型输入顺序无关。 */
  attachmentIndex: number;
  /** 是否为格式／大小适配的预览；false 仍可能是裁剪后的 PNG。 */
  isPreview: boolean;
  /** 原资产 MIME，可能与对话附件不同。 */
  originalMimeType: string;
};

/** 写入 context.text 的 Design 操作；生成参数放在 requests。 */
export interface DesignComposeOperation {
  /** 含插件命名空间的 generate 工具名。 */
  toolName: string;
  /** 文档定位与组装时快照；revision 不作执行版本门禁，sessionIdentity 只记录会话关联。 */
  document: Pick<DesignDocument, 'id' | 'revision' | 'sessionIdentity'>;
  /** 展示名称与数量标签：imageCountNames[n] 对应 n 张附件，[0] 为 name。 */
  summary: { name: string; imageCountNames: string[] };
  /** 按 sourceLayerIds 排列；crop 使用原资产像素坐标，省略为整图，不含其他图层效果。 */
  sources: (ComposeAttachment & { layerId: string; name: string; crop?: ImageLayer['crop'] })[];
  /** video／storyboard 的独立参考图，对应 referenceAssetIds。 */
  references?: ComposeAttachment[];
  /** 人物参考图，对应 modelAssetId，不是模型选择。 */
  model?: ComposeAttachment;
  /** Logo 图，对应 logoAssetId。 */
  logo?: ComposeAttachment;
  /** 首张源图的紫色选区标注，对应 annotationAssetId。 */
  annotation?: ComposeAttachment;
  /**
   * 完整生成参数；通常一项，多图 upscale 按源图拆项。
   * request.prompt 存所选推荐／模板／模特描述，当前自由要求留在外层 context.prompt。
   */
  requests: GenerationRequest[];
}
