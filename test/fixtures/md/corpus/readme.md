<p align="center">
  <img src="https://example.com/logo.png" alt="Widget logo" width="120" />
</p>

<h1 align="center">widget</h1>

[![CI](https://img.shields.io/badge/ci-passing-green)](https://github.com/acme/widget/actions)
[![npm](https://img.shields.io/npm/v/widget)][npm]

A small library for **widgets**. Works in Node 20+ and every modern browser.

## Install

```sh
npm install widget
```

## Usage

```js
import { widget } from "widget";

const w = widget({ size: 3 });
console.log(w.render()); // => "<widget>"
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `size` | `number` | `1` | How big the widget is, in widget units. |
| `color` | `string` | `"teal"` | Any CSS colour. |
| `onChange` | `(w) => void` | — | Called after every change. |

<details>
<summary>Advanced configuration</summary>

You can pass a custom renderer:

    widget({ renderer: myRenderer })

</details>

## Contributing

Pull requests are welcome. For major changes, open an issue first.
Read [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](LICENSE) © Acme

[npm]: https://www.npmjs.com/package/widget
