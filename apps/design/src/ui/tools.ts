export type CreativeTool = 'image' | 'white' | 'upscale' | 'watermark' | 'rectangle' | 'text' | 'erase-text' | 'angle' | 'resize' | 'erase' | 'brush' | 'translate' | 'remove-background' | 'product-scene' | 'recolor' | 'model-display' | 'logo' | 'scene-video' | 'multi-shot' | 'video' | 'storyboard';
export type GenerationTool = Exclude<CreativeTool, 'rectangle' | 'brush' | 'erase' | 'text' | 'erase-text' | 'white' | 'upscale' | 'watermark'>;

export const toolTitles: Record<CreativeTool, string> = {
  image: '生成图片', white: '白底图', upscale: '高清', watermark: '水印擦除', rectangle: '局部修改', text: '编辑文字', 'erase-text': '擦除文字', angle: '变换视角', resize: '改尺寸', erase: '消除', brush: '涂抹重绘', translate: '翻译', 'remove-background': '抠图', 'product-scene': '商品场景图', recolor: '商品换色', 'model-display': '模特展示图', logo: 'Logo效果图', 'scene-video': '场景视频', 'multi-shot': '多镜头视频推荐', video: '指令视频', storyboard: '多镜头生成与合成',
};
