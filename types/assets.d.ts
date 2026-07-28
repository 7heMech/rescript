/** Static image imports used via `next/image` (e.g. `@/assets/logo.png`). */
declare module "*.png" {
  import type { StaticImageData } from "next/image";
  const src: StaticImageData;
  export default src;
}

declare module "*.jpg" {
  import type { StaticImageData } from "next/image";
  const src: StaticImageData;
  export default src;
}

declare module "*.jpeg" {
  import type { StaticImageData } from "next/image";
  const src: StaticImageData;
  export default src;
}

declare module "*.webp" {
  import type { StaticImageData } from "next/image";
  const src: StaticImageData;
  export default src;
}

declare module "*.gif" {
  import type { StaticImageData } from "next/image";
  const src: StaticImageData;
  export default src;
}

declare module "*.svg" {
  import type { StaticImageData } from "next/image";
  const src: StaticImageData;
  export default src;
}
