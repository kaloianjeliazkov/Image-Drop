import { handleUpload } from '@vercel/blob/client';
import { NextResponse } from 'next/server';
import { addFoldersToRegistry, sanitizeFolderName } from '../../../lib/folderRegistry';

export async function POST(request) {
  const body = await request.json();

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        return {
          maximumSizeInBytes: 250 * 1024 * 1024, // 250 MB
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        // Register the folder server-side so the folder tab stays visible on
        // every device, including iOS home screen bookmarks
        try {
          const folder = sanitizeFolderName(blob.pathname.split('/')[0]);
          await addFoldersToRegistry([folder]);
        } catch (e) {
          console.error('Failed to register upload folder:', e);
        }
      },
    });

    return NextResponse.json(jsonResponse);
  } catch (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 400 }
    );
  }
}
