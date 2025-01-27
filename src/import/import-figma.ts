import * as Figma from 'figma-api';
import SVGO from 'svgo';
import fetch from 'node-fetch';
import { em, rem } from 'polished';
import setWith from 'lodash.setwith';
import colorConvert from 'color-convert';

import { getFile } from '../api';
import { logError } from '../utils/log';
import type {
  Dictionary,
  Breakpoints,
  GridVariant,
  Icons,
  OptimisedSVG,
  Palette,
  Radii,
  Shadows,
  Sizes,
  Spacing,
  Typography,
  TextVariant,
  Tokens,
} from '../utils/types';

/**
 * Figma utility functions
 */

// Fetch a canvas from a Figma document by the page name
export const getPageCanvasByName = (
  document: Figma.Node<'DOCUMENT'>,
  pageName: string
): Figma.Node<'CANVAS'> | undefined => {
  return (
    document.children
      // Get all the page canvases from the document
      .filter((c): c is Figma.Node<'CANVAS'> => Figma.isNodeType(c, 'CANVAS'))
      // Return the first one that has a matching name
      .find((canvas) => {
        // Strip non-alphanumeric characters (e.g. emojis) from canvas name before comparing
        const canvasName = canvas.name.toLowerCase().replace(/[^0-9a-z]/g, '');
        return canvasName === pageName.toLowerCase();
      })
  );
};

// Recursively search through a Figma canvas to return all nodes of a certain type
type FindableNode = keyof Omit<Figma.NodeTypes, 'DOCUMENT' | 'CANVAS'>;
const getAllNodesByType = <T extends FindableNode>(
  type: T,
  from: Figma.Node<'CANVAS'>
): Figma.Node<T>[] => {
  const nodes: Figma.Node<T>[] = [];

  // Iterate through the child nodes
  for (let i = 0; i < from.children.length; i += 1) {
    const child = from.children[i];
    switch (child.type) {
      // If a node matchs the given type, scoop it up and recursively search it's children
      case type:
        nodes.push(child as Figma.Node<T>);
        if ('children' in child) {
          nodes.push(...getAllNodesByType(type, child as Figma.Node<'CANVAS'>));
        }
        break;
      case 'INSTANCE':
        // Skip component instances as they may have overridden values
        break;
      default:
        // Otherwise if the node has children, recursively search it
        if ('children' in child) {
          nodes.push(...getAllNodesByType(type, child as Figma.Node<'CANVAS'>));
        }
        break;
    }
  }

  return nodes;
};
// Helper function to get all frame nodes from a page
const getAllFrameNodes = (from: Figma.Node<'CANVAS'>) =>
  getAllNodesByType('FRAME', from);
// Helper function to get all rectangle nodes from a page
const getAllRectangleNodes = (from: Figma.Node<'CANVAS'>) =>
  getAllNodesByType('RECTANGLE', from);
// Helper function to get all text nodes from a page
const getAllTextNodes = (from: Figma.Node<'CANVAS'>) =>
  getAllNodesByType('TEXT', from);
// Helper function to get all component nodes from a page
const getAllComponentNodes = (from: Figma.Node<'CANVAS'>) =>
  getAllNodesByType('COMPONENT', from);

// Convert a Figma shadow "effect style" to a CSS box-shadow value
const convertFigmaShadowToCss = (shadow: Figma.EffectShadow): string => {
  // Use 'inset' for inner shadows
  const type = shadow.type === Figma.EffectType.INNER_SHADOW ? 'inset ' : '';

  // Convert shadow colour to CSS value
  const r = Math.round(shadow.color.r * 255);
  const g = Math.round(shadow.color.g * 255);
  const b = Math.round(shadow.color.b * 255);
  const a = parseFloat(shadow.color.a.toFixed(2));
  const colour = `rgba(${r}, ${g}, ${b}, ${a})`;

  // Convert shadow offset and radius to px
  const x = shadow.offset.x === 0 ? '0' : `${shadow.offset.x}px`;
  const y = shadow.offset.y === 0 ? '0' : `${shadow.offset.y}px`;
  const radius = shadow.radius === 0 ? '0' : `${shadow.radius}px`;
  const spread = shadow.spread ? `${shadow.spread}px` : '0';

  return `${type}${x} ${y} ${radius} ${spread} ${colour}`;
};

/**
 * Design token extraction functions
 */

// Extract 'breakpoint' design tokens from a canvas
export const getBreakpoints = (canvas: Figma.Node<'CANVAS'>): Breakpoints => {
  const prefix = 'breakpoint-';
  const breakpoints = [
    ...getAllRectangleNodes(canvas),
    ...getAllFrameNodes(canvas),
  ]
    // Get all the rectangles and frames with a name prefixed 'breakpoint-'
    .filter((r) => r.name.startsWith(prefix))
    // Get the name and pixel width of the rectangles
    .map((r) => ({
      name: r.name.replace(prefix, ''),
      width: r.absoluteBoundingBox.width,
    }))
    // Sort the widths in ascending order
    .sort((a, b) => a.width - b.width)
    // Convert pixels to rem
    .map((r) => ({
      name: r.name,
      width: em(r.width),
    }));

  // Convert array to object
  return breakpoints.reduce(
    (obj, r) => ({
      ...obj,
      [r.name]: r.width,
    }),
    {}
  );
};

// Extract 'colour' design tokens from colour styles and a canvas, using name prefix
export const getColours = (
  canvas: Figma.Node<'CANVAS'>,
  styles: Dictionary<Figma.Style>
): Palette => {
  // Get all the colour styles with the provided prefix in their name
  const prefix = 'custom/';
  const colourStyles: Dictionary<string> = {};
  Object.keys(styles).forEach((key) => {
    const effect = styles[key];
    if (effect.name.startsWith(prefix)) {
      colourStyles[key] = effect.name.replace(prefix, '');
    }
  });

  // Get all the rectangles and frames that are using one of the colour styles
  const rectangles = [
    ...getAllRectangleNodes(canvas),
    ...getAllFrameNodes(canvas),
  ].filter((r) => {
    const fillKey = r.styles?.fill;
    if (fillKey === undefined) {
      return false;
    }

    return Object.keys(colourStyles).includes(fillKey);
  });

  const palette: Palette = {};
  rectangles.forEach((r) => {
    // Figma typings claim that a canvas has no fills property, this is a lie
    const colour = (r as Figma.Node<'RECTANGLE'>).fills[0].color;
    const fillKey = r.styles?.fill;
    if (fillKey === undefined || colour === undefined) {
      return;
    }

    // Convert each colour from RGB to HEX
    const red = Math.round(colour.r * 255);
    const green = Math.round(colour.g * 255);
    const blue = Math.round(colour.b * 255);
    const hex = colorConvert.rgb.hex([red, green, blue]);
    const key = colourStyles[fillKey].replace(/\//g, '.');
    setWith(palette, key, `#${hex}`, Object);
  });

  return palette;
};

// Extract 'border radius' design tokens from a canvas
export const getRadii = (canvas: Figma.Node<'CANVAS'>): Radii => {
  const prefix = 'radii-';
  const radii = [...getAllRectangleNodes(canvas), ...getAllFrameNodes(canvas)]
    // Get all the rectangles and frames with a name prefixed 'radii-'
    .filter((r) => r.name.startsWith(prefix))
    // Get the name and border radius of the rectangles
    .map((r) => ({
      name: r.name,
      // Figma typings claim that a canvas has no cornerRadius property, this is a lie
      cornerRadius: (r as Figma.Node<'RECTANGLE'>).cornerRadius,
    }))
    // Sort them in ascending order of radius
    .sort((a, b) => a.cornerRadius - b.cornerRadius)
    // Remove prefix from name and convert radius from px to rem
    .map((r) => ({
      name: r.name.replace(prefix, ''),
      cornerRadius: r.cornerRadius ? rem(r.cornerRadius) : '0',
    }));

  // Convert array to object
  return radii.reduce(
    (obj, r) => ({
      ...obj,
      [r.name]: r.cornerRadius,
    }),
    {}
  );
};

// Extract 'box shadow' design tokens from a canvas
export const getShadows = (
  canvas: Figma.Node<'CANVAS'>,
  styles: Dictionary<Figma.Style>
): Shadows => {
  // Get all the effect styles with a name prefixed 'shadow-'
  const prefix = 'shadow-';
  const shadowStyles: Dictionary<string> = {};
  Object.keys(styles).forEach((key) => {
    const style = styles[key];
    if (style.name.startsWith(prefix)) {
      shadowStyles[key] = style.name.replace(prefix, '');
    }
  });

  // Get all the rectangles and frames from the canvas that are using one of these effect styles
  const rectangles = [
    ...getAllRectangleNodes(canvas),
    ...getAllFrameNodes(canvas),
  ].filter((r) => {
    const effectKey = r.styles?.effect;
    if (effectKey === undefined) {
      return false;
    }

    return Object.keys(shadowStyles).includes(effectKey);
  });

  const shadows: Dictionary<string> = {};
  rectangles.forEach((r) => {
    const effects = r.effects;
    const effectKey = r.styles?.effect;
    if (effects === undefined || effectKey === undefined) {
      return;
    }

    // Convert each shadow to a CSS `box-shadow` value, then join them
    shadows[shadowStyles[effectKey]] = effects
      .map((e) => convertFigmaShadowToCss(e as Figma.EffectShadow))
      .reverse()
      .join(', ');
  });

  return shadows;
};

// Extract 'sizes' design tokens from a canvas
export const getSizes = (canvas: Figma.Node<'CANVAS'>): Sizes => {
  const prefix = 'size-';
  const sizes = [...getAllRectangleNodes(canvas), ...getAllFrameNodes(canvas)]
    // Get all the rectangles and frames with a name prefixed 'size-'
    .filter((r) => r.name.startsWith(prefix))
    // Get the name and pixel size of the rectangles
    .map((r) => ({ name: r.name, size: r.absoluteBoundingBox.width }))
    // Sort them in ascending order of size
    .sort((a, b) => a.size - b.size)
    // Remove prefix from name and convert size from px to rem
    .map((r) => ({
      name: r.name.replace(prefix, ''),
      size: r.size > 1 ? rem(r.size) : `${r.size}px`,
    }));

  // Convert array to object
  return sizes.reduce(
    (obj, s) => ({
      ...obj,
      [s.name]: s.size,
    }),
    {}
  );
};

// Extract 'spacing' design tokens from a canvas
export const getSpacing = (canvas: Figma.Node<'CANVAS'>): Spacing => {
  const prefix = 'space-';
  const spacing = getAllComponentNodes(canvas)
    // Get all the components with a name prefixed 'space-'
    .filter((r) => r.name.startsWith(prefix))
    // Get the name and pixel size of the rectangles
    .map((r) => ({ name: r.name, size: r.absoluteBoundingBox.height }))
    // Sort them in ascending order of size
    .sort((a, b) => a.size - b.size)
    // Remove prefix from name and convert size from px to rem
    .map((r) => ({
      name: r.name.replace(prefix, ''),
      size: r.size > 1 ? rem(r.size) : `${r.size}px`,
    }));

  // Convert array to object
  return spacing.reduce(
    (obj, s) => ({
      ...obj,
      [s.name]: s.size,
    }),
    {}
  );
};

// Extract 'font families' design tokens from a canvas
export const getFontFamilies = (
  canvas: Figma.Node<'CANVAS'>
): Typography['fonts'] => {
  // TODO: Support importing font stacks (e.g. "Roboto, Arial, sans-serif")
  const prefix = 'font-';
  const fonts = getAllTextNodes(canvas)
    // Get all the text elements with a name prefixed 'font-'
    .filter((e) => e.name.startsWith(prefix))
    // Get the name and font family of the elements
    .map((e) => ({
      name: e.name.replace(prefix, ''),
      fontFamily: e.style.fontFamily,
    }));

  // Convert array to object
  const fontMap = fonts.reduce(
    (obj, s) => ({
      ...obj,
      [s.name]: s.fontFamily,
    }),
    {}
  );

  // If "heading" or "body" fonts are missing, log error(s) and exit
  const missingBody = 'body' in fontMap === false;
  const missingHeading = 'heading' in fontMap === false;
  if (missingBody) {
    logError(
      'Body font not found in "Typography" page',
      `- Please add a text element named "${prefix}body".`
    );
  }
  if (missingHeading) {
    logError(
      'Heading font not found in "Typography" page',
      `- Please add a text element named "${prefix}heading".`
    );
  }
  if (missingBody || missingHeading) {
    throw new Error();
  }

  return fontMap;
};

// Extract 'font sizes' design tokens from a canvas
export const getFontSizes = (
  canvas: Figma.Node<'CANVAS'>
): Typography['fontSizes'] => {
  const prefix = 'fontSize-';
  const fontSizes = getAllTextNodes(canvas)
    // Get all the text element with a name prefixed 'fontSize-'
    .filter((e) => e.name.startsWith(prefix))
    // Get the name and font size of the elements
    .map((e) => ({ name: e.name, size: e.style.fontSize }))
    // Sort them in ascending order of font size
    .sort((a, b) => a.size - b.size)
    // Remove prefix from name and convert font size from px to rem
    .map((s) => ({
      name: s.name.replace(prefix, ''),
      size: rem(s.size),
    }));

  // Convert array to object
  return fontSizes.reduce(
    (obj, s) => ({
      ...obj,
      [s.name]: s.size,
    }),
    {}
  );
};

export const getGridStyles = (
  canvas: Figma.Node<'CANVAS'>,
  styles: Dictionary<Figma.Style>
): { [key: string]: GridVariant } => {
  // Get all the grid styles
  const gridStyles: Dictionary<string> = {};
  Object.keys(styles).forEach((key) => {
    const style = styles[key];
    if (style.styleType === 'GRID') {
      gridStyles[key] = style.name;
    }
  });
  // Get all the frame elements that are using one of the styles
  const frameElements = getAllFrameNodes(canvas).filter((t) => {
    const styleKey = t.styles?.grid;
    if (styleKey === undefined) {
      return false;
    }
    return Object.keys(gridStyles).includes(styleKey);
  });
  // Extract the styles from each frame element
  const variants: { [key: string]: GridVariant } = {};
  frameElements.forEach((t) => {
    const styleKey = t.styles?.grid;
    if (styleKey === undefined) {
      return;
    }

    // Find the first applied grid that uses columns and is a "stretch" type
    // (This is the only kind we support)
    const layoutGrid = t.layoutGrids?.find((g) => {
      return (
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        g.alignment === ('STRETCH' as any) &&
        g.pattern === Figma.LayoutGridPattern.COLUMNS
      );
    });
    if (!layoutGrid) {
      return;
    }

    // Get the grid values
    const values = {
      columns: layoutGrid.count,
      gutter: rem(`${layoutGrid.gutterSize}px`),
      margin: rem(`${layoutGrid.offset}px`),
    };

    // Get the style name and extract the breakpoint name if it exists (e.g. "sm" from "page/sm")
    let name = gridStyles[styleKey];
    const bp = name.split('/')?.[1];
    if (bp) {
      // If the style does correspond to a breakpoint, add the values under that key
      name = name.replace(`/${bp}`, '');
      setWith(variants, `${name}.columns.${bp}`, values.columns);
      setWith(variants, `${name}.gutter.${bp}]`, values.gutter);
      setWith(variants, `${name}.margin.${bp}]`, values.margin);
      return;
    }

    // Otherwise just assign the style object as normal
    variants[name] = values;
  });

  return variants;
};

const getLineHeightValue = (t: Figma.Node<'TEXT'>): string => {
  switch (t.style.lineHeightUnit) {
    case Figma.LineHeightUnit.PIXELS:
      // If the line height is defined in pixels, convert to rem
      return rem(t.style.lineHeightPx);
    case Figma.LineHeightUnit['FONT_SIZE_%']:
      // If the line height is defined in percentage, convert to a decimal
      return `${(t.style.lineHeightPercentFontSize ?? 0) / 100}`;
    case Figma.LineHeightUnit['INTRINSIC_%']:
      // Otherwise the line height is equivalent to "normal" in CSS
      return 'normal';
    default:
      return '';
  }
};

// Extract 'line heights' design tokens from a canvas
export const getLineHeights = (
  canvas: Figma.Node<'CANVAS'>
): Typography['lineHeights'] => {
  const prefix = 'lineHeight-';
  const lineHeights = getAllTextNodes(canvas)
    // Get all the text elements with a name prefixed 'lineHeight-'
    .filter((e) => e.name.startsWith(prefix))
    // Get the name and line height of the elements (removing the name prefix)
    .map((e) => ({
      name: e.name.replace(prefix, ''),
      lineHeight: getLineHeightValue(e),
    }));

  // Convert array to object
  return lineHeights.reduce(
    (obj, s) => ({
      ...obj,
      [s.name]: s.lineHeight,
    }),
    {}
  );
};

// Extract 'letter spacing' design tokens from a canvas
export const getLetterSpacing = (
  canvas: Figma.Node<'CANVAS'>
): Typography['letterSpacing'] => {
  const prefix = 'letterSpacing-';
  const letterSpacing = getAllTextNodes(canvas)
    // Get all the text element with a name prefixed 'letterSpacing-'
    .filter((e) => e.name.startsWith(prefix))
    // Get the name and calculate the letter spacing %
    .map((e) => ({
      name: e.name,
      letterSpacing: e.style.letterSpacing / e.style.fontSize,
    }))
    // Sort them in ascending order of letter spacing
    .sort((a, b) => a.letterSpacing - b.letterSpacing)
    // Remove prefix from name and convert letter spacing to em
    .map((l) => {
      const ls = parseFloat(l.letterSpacing.toFixed(3));
      return {
        name: l.name.replace(prefix, ''),
        letterSpacing: ls === 0 ? '0' : `${ls}em`,
      };
    });

  // Convert array to object
  return letterSpacing.reduce(
    (obj, s) => ({
      ...obj,
      [s.name]: s.letterSpacing,
    }),
    {}
  );
};

const getTextDecorationValue = (t: Figma.Node<'TEXT'>): string => {
  switch (t.style.textDecoration) {
    case Figma.TextDecoration.UNDERLINE:
      return 'underline';
    case Figma.TextDecoration.STRIKETHROUGH:
      return 'line-through';
    case Figma.TextDecoration.NONE:
    default:
      return 'none';
  }
};

const getTextTransformValue = (t: Figma.Node<'TEXT'>): string => {
  switch (t.style.textCase) {
    case Figma.TextCase.UPPER:
      return 'uppercase';
    case Figma.TextCase.LOWER:
      return 'lowercase';
    case Figma.TextCase.TITLE:
      return 'capitalize';
    case Figma.TextCase.ORIGINAL:
    default:
      return 'none';
  }
};

// Get the style values from a text element (i.e. font family, font size, etc.)
const getTextStyleValues = (t: Figma.Node<'TEXT'>): TextVariant => {
  const fontFamily = t.style.fontFamily;
  const fontSize = rem(t.style.fontSize);
  const fontStyle = t.style.italic ? 'italic' : 'normal';
  const fontWeight = `${t.style.fontWeight}`;
  const letterSpacing = `${parseFloat(
    (t.style.letterSpacing / t.style.fontSize).toFixed(3)
  )}em`;
  const lineHeight = getLineHeightValue(t);
  const textDecorationLine = getTextDecorationValue(t);
  const textTransform = getTextTransformValue(t);

  return {
    fontFamily,
    fontSize,
    fontStyle,
    fontWeight,
    letterSpacing,
    lineHeight,
    textDecorationLine,
    textTransform,
  };
};

export const getTextStyles = (
  canvas: Figma.Node<'CANVAS'>,
  styles: Dictionary<Figma.Style>
): { [key: string]: TextVariant } => {
  // Get all the text styles
  const textStyles: Dictionary<string> = {};
  Object.keys(styles).forEach((key) => {
    const style = styles[key];
    if (style.styleType === 'TEXT') {
      textStyles[key] = style.name;
    }
  });

  // Get all the text elements that are using one of the styles
  const textElements = getAllTextNodes(canvas).filter((t) => {
    const styleKey = t.styles?.text;
    if (styleKey === undefined) {
      return false;
    }

    return Object.keys(textStyles).includes(styleKey);
  });

  // Extract the styles from each text element
  const variants: { [key: string]: TextVariant } = {};
  textElements.forEach((t) => {
    const styleKey = t.styles?.text;
    if (styleKey === undefined) {
      return;
    }

    // Get the style values (i.e. font family, font size, etc.)
    const values = getTextStyleValues(t);
    // Get the style name and extract the breakpoint name if it exists (e.g. "sm" from "body/sm")
    let name = textStyles[styleKey];
    const bp = name.split('/')?.[1];

    if (bp) {
      // If the style does correspond to a breakpoint, add the values under that key
      name = name.replace(`/${bp}`, '');
      setWith(variants, `${name}.fontFamily.${bp}`, values.fontFamily);
      setWith(variants, `${name}.fontSize.${bp}]`, values.fontSize);
      setWith(variants, `${name}.fontStyle.${bp}]`, values.fontStyle);
      setWith(variants, `${name}.fontWeight.${bp}]`, values.fontWeight);
      setWith(variants, `${name}.letterSpacing.${bp}]`, values.letterSpacing);
      setWith(variants, `${name}.lineHeight.${bp}]`, values.lineHeight);
      setWith(
        variants,
        `${name}.textDecorationLine.${bp}]`,
        values.textDecorationLine
      );
      setWith(variants, `${name}.textTransform.${bp}]`, values.textTransform);
      return;
    }

    // Otherwise just assign the style object as normal
    variants[name] = values;
  });

  // Iterate over the styles and flatten any unnecessary responsive values
  // e.g. change `fontSize: { base: '1rem', sm: '1rem', md: '1rem' }` to just `fontSize: '1rem'`
  const flatten = (value: string | string[]) => {
    const objValues =
      typeof value === 'object' ? Object.values(value) : undefined;
    return objValues?.every((v) => v === objValues[0]) ? objValues[0] : value;
  };
  Object.keys(variants).forEach((k) => {
    const v = variants[k];
    variants[k] = {
      fontFamily: flatten(v.fontFamily),
      fontSize: flatten(v.fontSize),
      fontStyle: flatten(v.fontStyle),
      fontWeight: flatten(v.fontWeight),
      letterSpacing: flatten(v.letterSpacing),
      lineHeight: flatten(v.lineHeight),
      textDecorationLine: flatten(v.textDecorationLine),
      textTransform: flatten(v.textTransform),
    };
  });

  return variants;
};

type ProcessedIcon = {
  name: string;
  svg: OptimisedSVG;
};

// Extract SVG icons from a canvas
const getIcons = async (
  api: Figma.Api,
  fileKey: string,
  canvas: Figma.Node<'CANVAS'>
): Promise<Icons> => {
  const prefix = 'icon/custom/';
  const icons = getAllComponentNodes(canvas)
    // Get all the components with a name prefixed 'icon/custom/'
    .filter((r) => r.name.startsWith(prefix))
    // Get the name and node ID of the icon components
    .map((r) => ({
      name: r.name.replace(prefix, ''),
      id: r.id,
    }));

  if (icons.length === 0) {
    return {};
  }

  // Use the API to convert the icons to SVG images and get the image URLs back
  const iconIds = icons.map((i) => i.id);
  const response = await api.getImage(fileKey, {
    ids: iconIds.join(','),
    scale: 1,
    format: 'svg',
  });
  const imageUrls = response.images;

  // Take an image URL, fetch it and optimise it using SVGO
  const processIcon = async (imageUrl: string): Promise<OptimisedSVG> => {
    const image = await fetch(imageUrl);
    const svg = await image.text();
    const result = SVGO.optimize(svg);
    if (!('data' in result)) {
      throw new Error(`Error optimising SVG: ${result.error}`);
    }
    return result;
  };

  // Process all the image URLs asynchronously using promises
  const processedIcons: (ProcessedIcon | undefined)[] = await Promise.all(
    Object.keys(imageUrls).map(async (id) => {
      const imageUrl = imageUrls[id] as string;
      const name = icons.find((i) => i.id === id)?.name?.trim() ?? '';
      if (name === '') {
        logError(
          'Found a custom icon with an invalid name, skipping...',
          `- Please find any components in the Figma file named "${prefix}" and give them a proper name (e.g. "${prefix}close-button")`
        );
        return undefined;
      }
      return {
        name: name,
        svg: await processIcon(imageUrl),
      };
    })
  );

  // Filter out the skipped icons then convert the array to an object with the names as keys
  return processedIcons
    .filter((x): x is ProcessedIcon => x !== undefined)
    .reduce(
      (obj, r) => ({
        ...obj,
        [r.name]: r.svg,
      }),
      {}
    );
};

/**
 * Script
 */

// The names of the pages we want to extract from the Figma file
const pageNames = {
  breakpoints: 'Breakpoints',
  colours: 'Colours',
  grids: 'Grids',
  icons: 'Icons',
  radii: 'Radii',
  shadows: 'Shadows',
  sizes: 'Sizes',
  spacing: 'Spacing',
  typography: 'Typography',
};

export default async function importTokensFromFigma(
  apiKey: string,
  fileKey: string,
  version?: string
): Promise<Tokens> {
  // Fetch the Figma file based on the API and file keys
  const api = new Figma.Api({ personalAccessToken: apiKey });
  const file = await getFile(api, fileKey, version);

  // Find all the page canvases we need to extract tokens from, log an error and exit if any are missing
  let missingPage = false;
  const canvases: Dictionary<Figma.Node<'CANVAS'>> = {};
  Object.keys(pageNames).forEach((k) => {
    const key = k as keyof typeof pageNames;
    const canvas = getPageCanvasByName(file.document, pageNames[key]);
    if (canvas === undefined) {
      logError(
        `Unable to find a page with the name "${pageNames[key]}" in the file.`,
        '- Please check that this page exists in the Figma file.'
      );
      missingPage = true;
      return;
    }
    canvases[key] = canvas;
  });
  if (missingPage) {
    process.exit(1);
  }

  // Extract the design tokens from the file and return them in a Tokens object
  return {
    breakpoints: getBreakpoints(canvases.breakpoints),
    colours: getColours(canvases.colours, file.styles),
    gridStyles: getGridStyles(canvases.grids, file.styles),
    icons: await getIcons(api, fileKey, canvases.icons),
    radii: getRadii(canvases.radii),
    shadows: getShadows(canvases.shadows, file.styles),
    sizes: getSizes(canvases.sizes),
    spacing: getSpacing(canvases.spacing),
    typography: {
      fonts: getFontFamilies(canvases.typography),
      fontSizes: getFontSizes(canvases.typography),
      lineHeights: getLineHeights(canvases.typography),
      letterSpacing: getLetterSpacing(canvases.typography),
    },
    textStyles: getTextStyles(canvases.typography, file.styles),
  };
}
