# Batch Processing Feature

This document describes the batch PDF processing feature that has been added to the Vehicle Registration Form application.

## Overview

The batch processing feature allows users to upload up to 50 RC PDFs at once, which are then processed asynchronously on the server. Users can view the status of each submission, edit the extracted data manually if needed, and download the final PDF.

## Features

1. **Batch Upload**: Upload up to 50 PDF files at once
2. **Asynchronous Processing**: PDFs are processed in the background
3. **Status Tracking**: Real-time status updates for each submission
4. **Manual Editing**: Edit extracted data before generating the final PDF
5. **List View**: View all submissions with filtering by status
6. **Retry Failed Submissions**: Automatically retry processing for failed submissions
7. **Delete Submissions**: Remove unwanted submissions from the batch
8. **Current Functionality Preserved**: Single PDF upload workflow remains unchanged

## Architecture

### Frontend Components

- `BatchUpload.tsx`: Upload interface for selecting and uploading multiple PDFs
- `BatchListView.tsx`: List view showing all submissions with status filtering and retry/delete functionality
- `App.tsx`: Main app component now handles both single and batch editing in the same preview view
- `useBatchProcessor.ts`: Hook for processing pending submissions locally

### Backend

- **Cloud Function**: `processBatchSubmission` - Triggered when new submissions are created
- **Emulator**: In local dev, the Functions emulator runs `processBatchSubmission` in the background

### Database Structure

#### Firestore Collections

**batchJobs**
```typescript
{
  id: string;
  userId: string;
  userEmail: string;
  totalFiles: number;
  processedFiles: number;
  status: 'in_progress' | 'completed' | 'failed';
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

**batchSubmissions**
```typescript
{
  id: string;
  userId: string;
  userEmail: string;
  fileName: string;
  status: 'pending' | 'processing' | 'processed' | 'error';
  pdfUrl: string;
  batchJobId: string;
  extractedData?: FormData;
  errorMessage?: string;
  createdAt: Timestamp;
  processedAt?: Timestamp;
  updatedAt?: Timestamp;
}
```

#### Firebase Storage

- PDFs are stored at: `batch-pdfs/{userId}/{timestamp}-{filename}`

## Usage

### For Users

1. **Access Batch Mode**: From the home screen, click "Batch Processing" instead of single upload
2. **Upload Files**: Select or drag up to 50 PDF files
3. **Monitor Progress**: View the upload progress and status of each file
4. **View Submissions**: After upload, you'll be redirected to the list view
5. **Filter by Status**: Use the status cards to filter submissions
6. **Edit & Download**: Click "Edit & Download" on processed submissions to review and download

### For Developers

#### Running with Emulators

1. Start the Firebase emulators:
```bash
firebase emulators:start
```

2. In another terminal, start the Vite dev server:
```bash
npm run dev
```

3. The app will automatically connect to the emulators when running on localhost

#### Environment Variables

Make sure you have `.env.local` with:
```
GEMINI_API_KEY=your_gemini_api_key
```

## Status Flow

```
pending → processing → processed
                    ↘ error
```

- **pending**: Uploaded but not yet processed
- **processing**: Currently being processed by AI
- **processed**: Successfully processed, ready for editing
- **error**: Processing failed, error message available

## Security Rules

### Firestore Rules
- Users can only read/write their own batch jobs and submissions
- Authentication required for all operations

### Storage Rules
- Users can only access PDFs in their own folder
- Authentication required for upload/download

## Local Development Notes

- The `useBatchProcessor` hook simulates the Cloud Function trigger locally
- It listens for pending submissions and processes them via the local dev middleware
- In production, the Cloud Function will handle this automatically via Firestore triggers

## Deployment

When deploying to production:

1. Deploy Firestore rules:
```bash
firebase deploy --only firestore:rules
```

2. Deploy Storage rules:
```bash
firebase deploy --only storage:rules
```

3. Deploy Cloud Functions:
```bash
firebase deploy --only functions
```

4. Deploy Hosting:
```bash
npm run build
firebase deploy --only hosting
```

## Limitations

- Maximum 50 files per batch
- Maximum 10MB per PDF file
- Only PDF files are supported for batch processing
- Processing time depends on PDF complexity and AI API response time

## Future Enhancements

- Batch PDF generation (download all processed RCs at once)
- Email notifications when batch processing is complete
- Retry failed submissions
- Bulk editing of common fields across submissions
- Export to CSV/Excel
