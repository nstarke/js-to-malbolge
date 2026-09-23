const values = [];
console.log(values.pop()); // undefined
values.length = 2;
values[1] = 7;
console.log(values[0], values[1]); // undefined 7
console.log(values[0] === undefined, values[0] ?? 42); // true 42
console.log(values.pop(), values.pop(), values.length); // 7 undefined 0
