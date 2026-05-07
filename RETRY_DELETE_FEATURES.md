# Retry and Delete Features

## Overview

Added two important features to the batch processing system:
1. **Retry** - Automatically retry failed submissions
2. **Delete** - Remove unwanted submissions from the batch

## Features

### 1. Retry Failed Submissions

**When to use:**
- Processing failed due to network issues
- AI extraction returned an error
- PDF was corrupted or unreadable
- Want to try processing again after fixing an issue

**How it works:**
1. Click the "Retry" button on any failed submission
2. Status changes from "error" → "pending"
3. The submission is automatically picked up for processing
4. Error message is cleared
5. Processing starts fresh

**UI Elements:**
- Orange "Retry" button appears only on failed submissions
- Button shows spinning icon while retrying
- Button is disabled during retry operation

### 2. Delete Submissions

**When to use:**
- Wrong file was uploaded
- Don't need this submission anymore
- Want to clean up the list
- Submission is stuck or corrupted

**How it works:**
1. Click the "Delete" button on any submission
2. Confirmation modal appears with file details
3. Confirm deletion
4. Both the PDF file (Storage) and data (Firestore) are deleted
5. Submission is removed from the list

**Protection:**
- Cannot delete while processing (button disabled)
- Confirmation modal prevents accidental deletion
- Shows clear warning that action is permanent

**What gets deleted:**
- PDF file from Firebase Storage
- Firestore document from `batchSubmissions` collection
- All extracted data
- All metadata (timestamps, status, etc.)

## User Interface

### Submission Card Layout

```
┌─────────────────────────────────────────────────┐
│ [Icon] filename.pdf                    [Status] │
│        Registration No: HR26EB5601              │
│        Uploaded: timestamp                      │
│        [Owner] [Manufacturer] [Model]           │
│        [Edit & Download] [Retry] [Delete]       │
└─────────────────────────────────────────────────┘
```

### Button States

**Processed Submission:**
- ✅ Edit & Download (blue)
- 🗑️ Delete (red/gray)

**Failed Submission:**
- 🔄 Retry (orange)
- 🗑️ Delete (red/gray)

**Processing Submission:**
- 🗑️ Delete (disabled)

### Delete Confirmation Modal

```
┌───────────────────────────────┐
│         [Trash Icon]          │
│    Delete Submission?         │
│                               │
│  Are you sure you want to:    │
│  ┌─────────────────────────┐  │
│  │     filename.pdf        │  │
│  └─────────────────────────┘  │
│                               │
│  This action cannot be undone │
│                               │
│  [Cancel]  [Delete]           │
└───────────────────────────────┘
```

## Implementation Details

### Retry Logic

```typescript
const handleRetry = async (submissionId: string) => {
  // 1. Add to retrying set (for UI loading state)
  setRetryingIds(prev => new Set(prev).add(submissionId));
  
  // 2. Update Firestore document
  await updateDoc(submissionRef, {
    status: 'pending',        // Reset to pending
    errorMessage: null,       // Clear error
    updatedAt: serverTimestamp()
  });
  
  // 3. Processing hook picks it up automatically
  // 4. Remove from retrying set when done
};
```

### Delete Logic

```typescript
const handleDelete = async (submission) => {
  // 1. Show confirmation modal
  setDeleteConfirmation({ submission });
  
  // 2. On confirmation:
  //    a. Delete from Storage
  const storageRef = ref(storage, pdfPath);
  await deleteObject(storageRef);
  
  //    b. Delete from Firestore
  await deleteDoc(doc(db, 'batchSubmissions', id));
  
  // 3. Firestore listener removes from UI automatically
};
```

### Security

**Firestore Rules** (already in place):
```javascript
match /batchSubmissions/{submissionId} {
  allow read: if request.auth.uid == resource.data.userId;
  allow delete: if request.auth.uid == resource.data.userId;
  allow update: if request.auth.uid == resource.data.userId;
}
```

**Storage Rules** (already in place):
```javascript
match /batch-pdfs/{userId}/{filename} {
  allow read, delete: if request.auth.uid == userId;
}
```

## Error Handling

### Retry Errors
- Network error: Alert shown, retry can be attempted again
- Permission error: Alert shown, check authentication
- Document not found: Alert shown, may already be deleted

### Delete Errors
- Storage file not found: Warning logged, continues with Firestore deletion
- Firestore error: Alert shown, submission remains in list
- Network error: Alert shown, retry deletion

## User Experience

### Visual Feedback
- ✅ Loading states for all async operations
- ✅ Disabled buttons during operations
- ✅ Spinning icons for retry/delete in progress
- ✅ Confirmation modal with clear messaging
- ✅ Auto-removal from list after successful delete

### Accessibility
- ✅ Clear button labels
- ✅ Tooltips for disabled states
- ✅ Keyboard navigation support
- ✅ Focus management in modal
- ✅ Click outside to close modal

## Testing

### Test Retry Feature

1. **Create a failed submission:**
   - Temporarily disable network
   - Upload a PDF
   - Wait for processing to fail

2. **Test retry:**
   - Click "Retry" button
   - Verify button shows loading state
   - Verify status changes to "pending"
   - Verify processing restarts
   - Verify success after retry

### Test Delete Feature

1. **Delete a processed submission:**
   - Upload and process a PDF
   - Click "Delete" button
   - Verify confirmation modal appears
   - Click "Delete" in modal
   - Verify submission is removed
   - Check Storage (should be deleted)
   - Check Firestore (should be deleted)

2. **Cancel deletion:**
   - Click "Delete" button
   - Click "Cancel" in modal
   - Verify modal closes
   - Verify submission remains

3. **Try deleting during processing:**
   - Upload a PDF
   - Try to click "Delete" while processing
   - Verify button is disabled
   - Verify tooltip explains why

## Future Enhancements

Potential improvements:
- Batch retry (retry all failed at once)
- Batch delete (delete multiple selected)
- Soft delete with undo option
- Delete confirmation with checkbox
- Retry with modified settings
- Retry count/history tracking
