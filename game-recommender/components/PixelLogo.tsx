export default function PixelLogo({ size = 28 }: { size?: number }) {
  // 7x6 像素爱心，橙色主体 + 青色高光
  const cells: [number, number, string][] = [
    [1, 0, "#f88e1c"], [2, 0, "#f88e1c"], [4, 0, "#f88e1c"], [5, 0, "#f88e1c"],
    [0, 1, "#f88e1c"], [1, 1, "#6ccee3"], [2, 1, "#f88e1c"], [3, 1, "#f88e1c"], [4, 1, "#f88e1c"], [5, 1, "#f88e1c"], [6, 1, "#f88e1c"],
    [0, 2, "#f88e1c"], [1, 2, "#f88e1c"], [2, 2, "#f88e1c"], [3, 2, "#f88e1c"], [4, 2, "#f88e1c"], [5, 2, "#f88e1c"], [6, 2, "#f88e1c"],
    [1, 3, "#f88e1c"], [2, 3, "#f88e1c"], [3, 3, "#f88e1c"], [4, 3, "#f88e1c"], [5, 3, "#f88e1c"],
    [2, 4, "#f88e1c"], [3, 4, "#f88e1c"], [4, 4, "#f88e1c"],
    [3, 5, "#f88e1c"],
  ];
  const px = size / 7;
  return (
    <svg width={size} height={px * 6} viewBox="0 0 7 6" className="pixelated" aria-hidden>
      {cells.map(([x, y, fill]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={fill} />
      ))}
    </svg>
  );
}
