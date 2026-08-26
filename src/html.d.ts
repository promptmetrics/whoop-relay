// wrangler bundles *.html as Text modules (see "rules" in wrangler.jsonc)
declare module "*.html" {
  const text: string;
  export default text;
}
