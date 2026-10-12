import { handleUpload } from '@vercel/blob/client';
import { NextResponse } from 'next/server';

export async function POST(request) {
  const body = await request.json();

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        return {
          allowedContentTypes: [
            'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/svg+xml',
            'video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska'
          ],
          maximumSizeInBytes: 250 * 1024 * 1024, // 250 MB max per file
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        // Blob upload finished
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
