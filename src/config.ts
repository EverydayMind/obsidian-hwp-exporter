/**
 * Configuration constants for the shared HWPX converter.
 *
 * Centralizes all magic numbers and default values used throughout
 * the conversion process.
 */

export class ConversionConfig {
    // === Unit Conversion ===
    readonly LUNIT_PER_PX = (25.4 * 283.465) / 96.0; // Logical units per pixel (96 DPI)

    // === Table Layout ===
    readonly TABLE_WIDTH = 45000; // Default table width in logical units (~159mm)

    // === Cell Margins (default padding inside cells) ===
    readonly CELL_MARGIN_DEFAULT = {
        left: 510,
        right: 510,
        top: 141,
        bottom: 141,
    };

    // === List Indentation ===
    readonly LIST_INDENT_PER_LEVEL = 2000; // Indentation per nesting level

    // Bullet characters for different levels (Korean style)
    readonly LIST_BULLET_CHARS = ['ㅇ', '-', '∙', '●', '○', '■', '●'];

    // === Image Settings ===
    readonly IMAGE_MAX_WIDTH_MM = 150; // Maximum image width in mm
    readonly IMAGE_MAX_WIDTH = Math.floor(150 * 283.465); // ~42520 logical units
    readonly IMAGE_MAX_HEIGHT_MM = 200; // Maximum image height in mm
    readonly IMAGE_MAX_HEIGHT = Math.floor(200 * 283.465);
    readonly IMAGE_DEFAULT_WIDTH = 8504; // Default width (~30mm)
    readonly IMAGE_DEFAULT_HEIGHT = 8504; // Default height (~30mm)
    readonly USE_NATIVE_IMAGE_SIZE = true;

    // === Block Quote ===
    readonly BLOCKQUOTE_LEFT_INDENT = 2000; // Left margin indent for block quotes
    readonly BLOCKQUOTE_INDENT_PER_LEVEL = 2000; // Additional indent per nesting level

    // === Page Break ===
    readonly PAGE_BREAK_BEFORE_H1 = true; // Insert page break before H1 when not first block

    // === Link Styling ===
    readonly LINK_COLOR = '#0000FF'; // Blue
    readonly LINK_UNDERLINE = true;

    // === Highlight (==text==) without a {{HIGHLIGHT}} template style ===
    readonly HIGHLIGHT_COLOR = '#FFFF00';

    // === Security Limits ===
    readonly MAX_INPUT_FILE_SIZE = 50 * 1024 * 1024; // 50 MB max input file
    readonly MAX_TEMPLATE_FILE_SIZE = 50 * 1024 * 1024; // 50 MB max template file
    readonly MAX_NESTING_DEPTH = 20; // Max recursion for nested lists/quotes
    readonly MAX_IMAGE_COUNT = 500; // Max number of images in a single document
}

// Global default config instance
export const DEFAULT_CONFIG = new ConversionConfig();
