import { z } from '@content-desk/shared/zod';

// Workers isolate에서는 eval/new Function 기반 JIT 코드 생성이 금지되므로 첫 스키마 정의 전 비활성화
z.config({ jitless: true });
