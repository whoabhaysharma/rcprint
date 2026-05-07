/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface FormData {
  regnNo: string;
  regnDate: string;
  manufacturer: string;
  fuel: string;
  vehicleClass: string;
  bodyType: string;
  chassisNo: string;
  engineNo: string;
  modelNo: string;
  regdOwner: string;
  swdOf: string;
  address: string;
  cubicCapacity: string;
  seatCapacity: string;
  standCapacity: string;
  wheelBase: string;
  unladenWt: string;
  noOfCyc: string;
  ownerSerial: string;
  taxPaidUpto: string;
  regdValidity: string;
  colour: string;
  rlw: string;
  issuingAuthority: string;
  purpose: string;
  hypothecatedTo: string;
  manufacturingDt: string;
}

export type BatchStatus = 'pending' | 'processing' | 'processed' | 'error';

export interface BatchSubmission {
  id: string;
  userId: string;
  userEmail: string;
  fileName: string;
  status: BatchStatus;
  pdfUrl: string;
  extractedData?: Partial<FormData>;
  errorMessage?: string;
  createdAt: any;
  processedAt?: any;
  updatedAt?: any;
}

export interface BatchJob {
  id: string;
  userId: string;
  userEmail: string;
  totalFiles: number;
  processedFiles: number;
  status: 'in_progress' | 'completed' | 'failed';
  createdAt: any;
  updatedAt?: any;
}
