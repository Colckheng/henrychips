import type { Limits } from '../../src/contracts/tool.js';

export const limits: Limits = {
  fileBytes: 10_485_760,
  csvRows: 10_000,
  directoryEntries: 1000,
  pdfPages: 30,
  webBytes: 2_097_152,
  downloadBytes: 209_715_200,
  outputBytes: 209_715_200,
  toolTimeoutMs: 15_000,
};
