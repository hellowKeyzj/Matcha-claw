import { hostApiFetchDecoded } from './host-api';
import type { CallReceipt } from '@/types/call-log';
import { decodeCallReceipt } from '@/types/call-log/receipt';

export function prepareToolchain(): Promise<CallReceipt> {
  return hostApiFetchDecoded('/api/toolchain/uv/prepare', decodeCallReceipt, { method: 'POST' });
}
