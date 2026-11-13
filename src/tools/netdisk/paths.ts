/**
 * Turns the path of a file inside a share into a relative path that is safe
 * inside the output directory. A platform may hand out a path that carries an
 * id and a signature, so the name the user reads is used instead.
 */
export function safeOutputPath(filePath: string, fileName: string): string {
  const base = (fileName.trim() || filePath.split('/').pop() || 'download').split(/[\\/]/).pop() ?? 'download';
  const cleaned = base.replace(/[<>:"/\\|?*]/g, '_').replace(/[\u0000-\u001f]/g, '').replace(/[. ]+$/g, '').slice(0, 120);
  return cleaned || 'download';
}
