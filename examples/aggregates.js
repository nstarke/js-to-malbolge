function translate(point, dx, dy) {
  point.x += dx;
  point.y += dy;
  return point;
}

const points = [{x: 1, y: 2}, {x: 3, y: 4}];
const first = points[0];
for (let i = 0; i < points.length; i++) {
  const point = translate(points[i], 10, 20);
  console.log(point.x, point.y);
}
console.log(first === points[0], first.x);
