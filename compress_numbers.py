def compress_numbers(numbers):
    result = []
    for value in numbers:
        if not result or result[-1] != value:
            result.append(value)
    return result


def run_tests():
    cases = [
        ([1, 1, 2, 2, 3], [1, 2, 3]),
        ([0, 0, 1, 1, 0], [0, 1, 0]),
        ([], []),
        ([5], [5]),
        ([1, 2, 3], [1, 2, 3]),
        ([7, 7, 7, 7], [7]),
        ([1, 1, 1, 2, 2, 1], [1, 2, 1]),
        ([-1, -1, 0, 0, -1], [-1, 0, -1]),
        ([1.5, 1.5, 2.0], [1.5, 2.0]),
    ]
    for data, expected in cases:
        got = compress_numbers(data)
        assert got == expected, f"FAIL: {data} -> {got}, ожидалось {expected}"

    src = [1, 1, 2]
    compress_numbers(src)
    assert src == [1, 1, 2]

    src2 = [1, 2, 3]
    assert compress_numbers(src2) is not src2

    print("Все тесты пройдены")


run_tests()
