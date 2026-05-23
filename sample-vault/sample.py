"""Simple demo file to verify Python syntax highlighting."""

from typing import Iterable


def fibonacci(n: int) -> Iterable[int]:
    a, b = 0, 1
    for _ in range(n):
        yield a
        a, b = b, a + b


if __name__ == "__main__":
    print(list(fibonacci(10)))
