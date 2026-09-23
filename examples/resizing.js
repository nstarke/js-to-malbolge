// This can run with --heap-capacity 4 despite allocating on every iteration.
const values = [];
for (let i = 0; i < 20; i++) {
  values.push({value: i});
  console.log(values.pop().value);
}
values.length = 1;
values[0] = {value: 42};
console.log(values[0].value, values.length);
