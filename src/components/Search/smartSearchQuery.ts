/** Express OpenAPI validation requires spaces to use %20, not form-style +. */
export const serializeSmartSearchParams = (params: URLSearchParams): string =>
  params.toString().replace(/\+/g, '%20');
