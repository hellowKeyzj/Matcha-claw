import type { AnglePreset, GenerationAction, GenerationRequest } from '../document';

// Local camera instructions; the current Accio archive does not expose the original angle prompt.
const angleInstructions: Record<AnglePreset, string> = {
  front: 'Medium shot, eye-level camera (0 degrees vertically), 0-degree horizontal rotation; the subject faces the camera directly.',
  back: 'Medium shot, eye-level camera, 180-degree horizontal rotation; the subject faces completely away from the camera.',
  god: 'Medium shot, camera looking downward at 70 degrees from above for a bird’s-eye view.',
  side: 'Medium shot, eye-level camera, 90-degree horizontal rotation; show the subject in full profile.',
  'three-quarter-left': 'Medium shot, eye-level camera, -45-degree horizontal rotation; the subject turns toward the left of the frame in a three-quarter view.',
  'three-quarter-right': 'Medium shot, eye-level camera, 45-degree horizontal rotation; the subject turns toward the right of the frame in a three-quarter view.',
  'low-angle': 'Medium shot from below, camera looking upward at 45 degrees, horizontally facing the subject from the front.',
  'face-closeup': 'Extreme close-up, eye-level frontal camera tightly focused on the face.',
  environment: 'Wide long shot, eye-level frontal camera pulled far back; the subject appears small within a vast environment.',
};

export function generationPrompt(request: GenerationRequest, scenePrompt: string): string {
  const changedText = request.textEdits?.filter((edit) => edit.edited !== edit.original);
  // Executed literals/templates from Accio desktop 0.37.1; missing originals stay explicitly local below.
  const instructions: Record<GenerationAction, string> = {
    image: '',
    edit: request.annotationAssetId
      ? 'Image 1 is the selection reference (with box/brush annotations), Image 2 is the original product image. Use Image 2 as the base, and refer to the boxed or brushed areas in Image 1 as operation position guides. The boxes/brush marks are only for indicating edit positions and should not be kept in the final result. Remove the boxes/marks in the generated output and keep all other content unchanged.'
      : 'Edit the provided image(s) according to the request. Preserve unrelated content.',
    // Local transparent-output contract; no original was available in the reference archive.
    'remove-background': 'Remove the background from the provided image. Preserve the complete subject and fine edges. Return a transparent PNG.',
    upscale: 'Enhance resolution and sharpness without changing any content, colors, text, or layout.',
    erase: request.annotationAssetId
      ? 'Please remove the purple painted areas in the image. The purple color is used solely to mark the location of elements to be erased; no purple traces should remain in the final generated image. Apart from this, do not modify any other elements, including the background, lighting, colors, or composition. Maintain high fidelity — when in doubt, leave the image as is.'
      : 'Erase only the requested object or region and reconstruct the surrounding background naturally. Preserve all other content.',
    // Local full-image removal contract; this is not the product-preserving watermark operation.
    'erase-text': 'Remove all text throughout the entire provided image, including product print, labels, lettering, captions and text overlays. Reconstruct the underlying background or surface naturally. Preserve the product and all other non-text content, geometry, colors, textures, composition and lighting. Do not add replacement text.',
    angle: 'Change only the camera viewpoint using the selected angle preset below. Keep exactly the same subject or character, clothing, appearance and design style. Preserve the original details and do not redesign the subject or add extra elements.',
    white: `Replace the background with pure white (#FFFFFF).
CRITICAL: Preserve the product exactly — maintain sharp edges, original colors, textures, surface details, brand logos, and all text/labels on the product.
The brand identity elements (logos, text, tags) are part of the product and must NOT be removed or altered.
Do NOT generate a new product photo. Do NOT change perspective, product scale, shape, label text, material, lighting on the product surface, or add/remove accessories.`,
    watermark: `Remove only the watermark, website information, contact details, QR code, promotional sticker/overlay clutter, accidental overlay, stain, dust, or scanner mark from the image. Preserve product-related text and the product brand logo that is visibly present in the ORIGINAL image. IMPORTANT: Keep all product details, colors, textures, and structural features exactly unchanged.
Do not remove or alter any product labels, packaging text, specifications, brand marks that are part of the product, or non-target text.`,
    resize: `Image aspect ratio required: ${request.aspectRatio}. Only change the image dimensions; keep all subjects and elements in the image completely unchanged.`,
    translate: `Translate the text in the image into ${request.targetLanguage}, while preserving the original layout and design style.`,
    'edit-text': request.textEdits ? `参考标记图中文本框的位置，将原图中对应位置文字完成以下文案替换：

${(changedText?.length ? changedText : request.textEdits).map((edit) => `红色框{{${edit.marker}:${edit.original}}}替换为{{${edit.edited}}}；`).join('\n\n')}

并删除所有红色框` : '',
    'product-scene': '',
    recolor: request.colors ? `Change the product color to ${request.colors.map(({ hex, opacity }) => opacity < 100 ? `${hex} ${opacity}%` : hex).join('、')}` : '',
    'model-display': request.modelAssetId
      ? "Please strictly reference this model's appearance features (face shape, hairstyle, skin tone, temperament, etc.) and keep character consistency."
      : request.prompt.trim() ? '' : 'The model should match the target customer aesthetic of the product, with reasonable skin tone, hairstyle, and body shape, natural expression, and relaxed posture. Avoid exaggerated movements or stiff poses, and present an overall realistic and healthy visual impression.',
    logo: request.material ? `Customize the product with the logo image using ${request.material.trim()} craftsmanship.` : 'Apply the supplied logo to the product images as requested.',
    video: '',
    storyboard: '',
  };
  return [
    request.action === 'storyboard' ? request.prompt : '',
    scenePrompt,
    instructions[request.action],
    request.action === 'angle' ? `Camera preset ${request.anglePreset}: ${angleInstructions[request.anglePreset!]}` : '',
    request.modelAssetId ? 'The last image is the independent person reference; all preceding images are product or clothing images.' : '',
    request.logoAssetId ? 'The last image is the independent logo artwork; all preceding images are product images.' : '',
  ].filter(Boolean).join('\n\n');
}
