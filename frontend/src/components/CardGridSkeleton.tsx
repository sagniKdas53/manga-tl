import Box from "@mui/material/Box";
import Grid from "@mui/material/Grid";
import Skeleton from "@mui/material/Skeleton";

export interface CardGridSkeletonProps {
  /** How many placeholder cells to draw. Roughly a first screenful by default. */
  count?: number;
  /** Draws the title + action row the real grids render above their cells. */
  header?: boolean;
}

/**
 * Placeholder for the three card grids — the series dashboard, a series' chapters, and a
 * chapter's pages. All three share a cell shape (a 2/3 cover with a line or two beneath) and the
 * same responsive sizes, so one skeleton fits all of them.
 *
 * The point is the layout, not the animation: a centred spinner occupies no space, so the page
 * jumped from empty to full when the chunk arrived. These cells reserve the room.
 */
const CardGridSkeleton: React.FC<CardGridSkeletonProps> = ({
  count = 12,
  header = true,
}) => (
  <Box sx={{ p: { xs: 2, sm: 3 } }}>
    {header && (
      <Box
        sx={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          mb: 2,
        }}
      >
        <Skeleton
          variant="text"
          width={220}
          height={40}
        />
        <Skeleton
          variant="rounded"
          width={140}
          height={32}
        />
      </Box>
    )}
    <Grid
      container
      spacing={2}
    >
      {Array.from({ length: count }, (_, i) => (
        <Grid
          key={i}
          size={{ xs: 6, sm: 4, md: 3, lg: 2 }}
        >
          <Skeleton
            variant="rounded"
            sx={{ width: "100%", height: "auto", aspectRatio: "2/3" }}
          />
          <Skeleton
            variant="text"
            width="60%"
          />
          <Skeleton
            variant="text"
            width="85%"
          />
        </Grid>
      ))}
    </Grid>
  </Box>
);

export default CardGridSkeleton;
