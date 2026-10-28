export async function readSseData(reader: {
  read(): Promise<{ value?: Uint8Array; done: boolean }>;
}): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    const start = buffer.indexOf('data: ');
    if (start !== -1) return buffer.slice(start);
    if (done) return buffer;
  }
}