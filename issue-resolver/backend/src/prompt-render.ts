export function renderPlaceholders(
  template: string,
  values: Record<string, string>,
): string {
  let body = template;
  for (const [name, value] of Object.entries(values)) {
    body = body.replaceAll(`{{${name}}}`, value);
  }
  return body;
}
