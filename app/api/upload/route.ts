import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'

const BUCKET = 'verdix-files'

async function ensureBucket() {
  const { data: buckets } = await supabaseServer.storage.listBuckets()
  if (!buckets?.find(b => b.name === BUCKET)) {
    await supabaseServer.storage.createBucket(BUCKET, { public: false })
  }
}

export async function POST(req: NextRequest) {
  const formData = await req.formData()
  const file = formData.get('file') as File | null
  const jobId = formData.get('jobId') as string | null
  const fileType = (formData.get('fileType') as string | null) ?? 'contract'

  if (!file || !jobId) {
    return NextResponse.json({ error: 'file and jobId are required' }, { status: 400 })
  }

  await ensureBucket()

  const ext = file.name.split('.').pop() ?? 'bin'
  const path = `${jobId}/${fileType}.${ext}`
  const buffer = Buffer.from(await file.arrayBuffer())

  const { error: uploadError } = await supabaseServer.storage
    .from(BUCKET)
    .upload(path, buffer, {
      contentType: file.type || 'application/octet-stream',
      upsert: true,
    })

  if (uploadError) {
    return NextResponse.json({ error: `Upload failed: ${uploadError.message}` }, { status: 500 })
  }

  // Use a long-lived signed URL (7 days) since the bucket is private
  const { data: signedData, error: signError } = await supabaseServer.storage
    .from(BUCKET)
    .createSignedUrl(path, 60 * 60 * 24 * 7)

  if (signError || !signedData?.signedUrl) {
    return NextResponse.json({ error: `Signing failed: ${signError?.message}` }, { status: 500 })
  }

  const url = signedData.signedUrl
  const column = fileType === 'billing' ? 'billing_csv_url' : 'contract_pdf_url'

  const { error: updateError } = await supabaseServer
    .from('jobs')
    .update({ [column]: url })
    .eq('id', jobId)

  if (updateError) {
    return NextResponse.json({ error: `DB update failed: ${updateError.message}` }, { status: 500 })
  }

  return NextResponse.json({ path, url })
}
