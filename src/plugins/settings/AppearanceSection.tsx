import { useRef, type ChangeEvent } from 'react';
import { Sun, Moon, Monitor, Upload, Trash2, User } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { SettingsSectionProps } from '@/app/extensions';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { toUserMessage } from '@/lib/api-client';
import { SUPPORTED_LANGUAGES } from '@/i18n';
import { useSettingsStore } from './store';

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string' || !reader.result) {
        reject(new Error('avatar_invalid_data_url'));
        return;
      }
      resolve(reader.result);
    };
    reader.onerror = () => reject(new Error('avatar_file_read_failed'));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('avatar_image_decode_failed'));
    image.src = src;
  });
}

async function cropImageToSquareDataUrl(src: string, size = 128): Promise<string> {
  const image = await loadImageElement(src);
  const cropSize = Math.min(image.width, image.height);
  const sx = (image.width - cropSize) / 2;
  const sy = (image.height - cropSize) / 2;

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('avatar_canvas_unavailable');
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.clearRect(0, 0, size, size);
  context.drawImage(image, sx, sy, cropSize, cropSize, 0, 0, size, size);
  return canvas.toDataURL('image/png');
}

export default function AppearanceSection({ active }: SettingsSectionProps) {
  const { t } = useTranslation(['settings', 'common']);
  const theme = useSettingsStore((state) => state.theme);
  const setTheme = useSettingsStore((state) => state.setTheme);
  const language = useSettingsStore((state) => state.language);
  const setLanguage = useSettingsStore((state) => state.setLanguage);
  const userAvatarDataUrl = useSettingsStore((state) => state.userAvatarDataUrl);
  const setUserAvatarDataUrl = useSettingsStore((state) => state.setUserAvatarDataUrl);
  const clearUserAvatar = useSettingsStore((state) => state.clearUserAvatar);
  const launchAtStartup = useSettingsStore((state) => state.launchAtStartup);
  const setLaunchAtStartup = useSettingsStore((state) => state.setLaunchAtStartup);
  const userAvatarInputRef = useRef<HTMLInputElement | null>(null);

  const handleAvatarFileSelect = async (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    event.target.value = '';
    if (!selectedFile) {
      return;
    }
    if (!selectedFile.type.startsWith('image/')) {
      toast.error(t('appearance.avatarInvalidType'));
      return;
    }

    try {
      const sourceDataUrl = await readFileAsDataUrl(selectedFile);
      const squareAvatarDataUrl = await cropImageToSquareDataUrl(sourceDataUrl, 128);
      await setUserAvatarDataUrl(squareAvatarDataUrl);
      toast.success(t('appearance.avatarUpdated'));
    } catch (error) {
      toast.error(t('appearance.avatarUpdateFailed', { error: String(error) }));
    }
  };

  const handleClearAvatar = async () => {
    try {
      await clearUserAvatar();
      if (userAvatarInputRef.current) {
        userAvatarInputRef.current.value = '';
      }
      toast.success(t('appearance.avatarCleared'));
    } catch (error) {
      toast.error(t('appearance.avatarUpdateFailed', { error: String(error) }));
    }
  };

  if (!active) return null;
  return (
      <Card className="order-2">
        <CardHeader>
          <CardTitle>{t('appearance.title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>{t('appearance.theme')}</Label>
            <div className="flex gap-2">
              <Button
                variant={theme === 'light' ? 'default' : 'outline'}
                size="sm"
                onClick={() => {
                  void setTheme('light').catch((error) => {
                    toast.error(`${t('common:status.error')}: ${toUserMessage(error)}`);
                  });
                }}
              >
                <Sun className="h-4 w-4 mr-2" />
                {t('appearance.light')}
              </Button>
              <Button
                variant={theme === 'dark' ? 'default' : 'outline'}
                size="sm"
                onClick={() => {
                  void setTheme('dark').catch((error) => {
                    toast.error(`${t('common:status.error')}: ${toUserMessage(error)}`);
                  });
                }}
              >
                <Moon className="h-4 w-4 mr-2" />
                {t('appearance.dark')}
              </Button>
              <Button
                variant={theme === 'system' ? 'default' : 'outline'}
                size="sm"
                onClick={() => {
                  void setTheme('system').catch((error) => {
                    toast.error(`${t('common:status.error')}: ${toUserMessage(error)}`);
                  });
                }}
              >
                <Monitor className="h-4 w-4 mr-2" />
                {t('appearance.system')}
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            <Label>{t('appearance.language')}</Label>
            <div className="flex gap-2">
              {SUPPORTED_LANGUAGES.map((lang) => (
                <Button
                  key={lang.code}
                  variant={language === lang.code ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => { void setLanguage(lang.code).catch(() => {}); }}
                >
                  {lang.label}
                </Button>
              ))}
            </div>
          </div>
          <Separator />
          <div className="space-y-3">
            <div>
              <Label>{t('appearance.userAvatar')}</Label>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-muted">
                {userAvatarDataUrl ? (
                  <img
                    src={userAvatarDataUrl}
                    alt={t('appearance.userAvatarPreviewAlt')}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <User className="h-6 w-6 text-muted-foreground" />
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={userAvatarInputRef}
                  type="file"
                  accept="image/*"
                  className="sr-only"
                  aria-label={t('appearance.uploadAvatarInputLabel')}
                  onChange={(event) => {
                    void handleAvatarFileSelect(event);
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => userAvatarInputRef.current?.click()}
                >
                  <Upload className="mr-2 h-4 w-4" />
                  {t('appearance.uploadAvatar')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={!userAvatarDataUrl}
                  onClick={handleClearAvatar}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t('appearance.clearAvatar')}
                </Button>
              </div>
                <div className="ml-auto flex w-auto max-w-full items-center gap-3">
                  <div className="max-w-[240px]">
                    <Label className="text-[15px] font-medium text-foreground/80">{t('appearance.launchAtStartup')}</Label>
                  </div>
                  <Switch
                    checked={launchAtStartup}
                    onCheckedChange={(value) => { void setLaunchAtStartup(value).catch(() => {}); }}
                  />
                </div>
              </div>
            </div>
        </CardContent>
      </Card>
  );
}
