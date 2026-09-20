import Foundation

/// Codex pet atlas layout, mirroring the plugin's `shared/atlas.ts`.
struct AtlasLayout {
    let version: Int
    let width: Int
    let height: Int
    let cellWidth: Int
    let cellHeight: Int
    let columns: Int
    let rows: Int
    let requiredFramesByRow: [Int]
}

let atlasV1 = AtlasLayout(
    version: 1, width: 1536, height: 1872,
    cellWidth: 192, cellHeight: 208, columns: 8, rows: 9,
    requiredFramesByRow: [6, 8, 8, 4, 5, 8, 6, 6, 6]
)

let atlasV2 = AtlasLayout(
    version: 2, width: 1536, height: 2288,
    cellWidth: 192, cellHeight: 208, columns: 8, rows: 11,
    requiredFramesByRow: [6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8]
)

/// Atlas selection is by pixel dimensions, not by the manifest version field.
func atlasForDimensions(width: Int, height: Int) -> AtlasLayout? {
    if width == atlasV1.width && height == atlasV1.height { return atlasV1 }
    if width == atlasV2.width && height == atlasV2.height { return atlasV2 }
    return nil
}
