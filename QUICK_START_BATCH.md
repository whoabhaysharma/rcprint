# Quick Start Guide - Batch Processing

## Setup & Testing (Local Development with Emulators)

### 1. Start Firebase Emulators

In one terminal:
```bash
firebase emulators:start
```

This will start:
- Auth Emulator (port 9099)
- Firestore Emulator (port 8080)
- Storage Emulator (port 9199)
- Functions Emulator (port 5001)
- Emulator UI (port 4000)

### 2. Start Development Server

In another terminal:
```bash
npm run dev
```

The app will run on `http://localhost:3000` and automatically connect to emulators.

### 3. Test the Feature

1. **Open the app** at `http://localhost:3000`

2. **Sign in** with Google (emulator will show a test login page)

3. **Choose Batch Processing** from the home screen

4. **Upload Test PDFs**:
   - Click or drag up to 50 PDF files
   - Files will be validated (PDFs only, max 10MB each)
   - Click "Upload" button

5. **Monitor Processing**:
   - You'll be redirected to the list view
   - Watch as files change from "Pending" → "Processing" → "Processed"
   - Use the status filter cards to filter by status

6. **Edit & Download**:
   - Click "Edit & Download" on a processed submission
   - Opens the same form/preview view used for single PDFs
   - Review and edit the extracted data
   - Upload a signature if needed
   - Click "Save" to save changes without downloading
   - Click "Download Official RC" to generate and download the PDF
   - Back button returns to batch list

7. **Retry Failed Submissions**:
   - If a submission fails, click the "Retry" button
   - The submission will be reset to "pending" status
   - Processing will automatically restart

8. **Delete Submissions**:
   - Click the "Delete" button on any submission
   - Confirm deletion in the modal
   - The PDF and all data will be permanently removed
   - Note: Cannot delete while processing

### 4. View Emulator Data

Open `http://localhost:4000` to view:
- Firestore collections (batchJobs, batchSubmissions)
- Storage files (batch-pdfs/)
- Auth users

## How It Works (Local Dev)

1. **Upload**: Files are uploaded to Storage Emulator
2. **Database Entry**: Firestore entry created with status="pending"
3. **Trigger (background)**: Functions emulator triggers `processBatchSubmission` on Firestore create
4. **Extraction**: Gemini AI extracts data from PDF
5. **Update**: Status changes to "processed" with extracted data
6. **Edit**: User can review and edit data
7. **Download**: Generate final RC PDF

## Current Functionality Preserved

The existing single-PDF workflow remains completely unchanged:
- Drag & drop single PDF on home screen
- Manual entry still available
- Calibration tool still works
- All existing features work exactly as before

## Key Files Changed

### New Files
- `src/types.ts` - TypeScript interfaces
- `src/BatchUpload.tsx` - Upload component
- `src/BatchListView.tsx` - List view with retry/delete functionality
- `firestore.rules` - Security rules for Firestore
- `storage.rules` - Security rules for Storage

### Modified Files
- `src/firebase.ts` - Added Storage, emulator connection
- `src/App.tsx` - Integrated batch mode with existing preview view, added batch context handling
- `vite.config.ts` - Added batch processing middleware
- `functions/index.js` - Added Cloud Function for batch processing
- `firebase.json` - Added emulator config and rules

### Removed Files
- `src/BatchDetailView.tsx` - No longer needed (reuses existing preview view)

## Testing Checklist

- [ ] Upload single PDF (old workflow) - should work as before
- [ ] Upload batch of PDFs - should upload all files
- [ ] Monitor status changes - should see pending → processing → processed
- [ ] Filter by status - should show only selected status
- [ ] Edit processed submission - should load data correctly
- [ ] Save changes - should persist to Firestore
- [ ] Download PDF - should generate and download
- [ ] **Retry failed submission** - should reset to pending and reprocess
- [ ] **Delete submission** - should show confirmation modal and delete
- [ ] **Delete during processing** - button should be disabled
- [ ] Error handling - try uploading invalid file (should show error)
- [ ] Max files limit - try uploading 51 files (should warn)
- [ ] File size limit - try uploading >10MB file (should warn)

## Troubleshooting

### "Cannot connect to emulators"
- Make sure emulators are running (`firebase emulators:start`)
- Check that ports are not in use (9099, 8080, 9199, 5001, 4000)

### "Missing GEMINI_API_KEY"
- Create `.env.local` in project root
- Add: `GEMINI_API_KEY=your_api_key_here`

### "Processing stuck at pending"
- Check browser console for errors
- Verify `useBatchProcessor` hook is running
- Check that `/api/processBatchSubmission` endpoint is working

### "Storage upload failed"
- Verify Storage emulator is running (port 9199)
- Check browser console for CORS errors
- Ensure you're logged in

## Next Steps

Once tested locally, you can:
1. Deploy rules: `firebase deploy --only firestore:rules,storage:rules`
2. Deploy functions: `firebase deploy --only functions`
3. Build frontend: `npm run build`
4. Deploy hosting: `firebase deploy --only hosting`

Note: In production, the Cloud Function will automatically process submissions (no need for `useBatchProcessor` hook).
