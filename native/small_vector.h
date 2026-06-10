#pragma once

#include <cstddef>
#include <initializer_list>
#include <iterator>
#include <new>
#include <type_traits>
#include <utility>

// SmallVector<T, N> — stack-allocated vector with heap overflow.
// API subset: push_back, emplace_back, begin/end, insert, erase,
// resize, reserve, size/empty/clear, operator[], copy/move semantics.
template<typename T, size_t N>
class SmallVector {
    using Storage = std::aligned_storage_t<sizeof(T), alignof(T)>;

    Storage inline_[N == 0 ? 1 : N];
    T* data_ = inlineData();
    size_t size_ = 0;
    size_t cap_ = N;

    T* inlineData() noexcept {
        return reinterpret_cast<T*>(inline_);
    }

    const T* inlineData() const noexcept {
        return reinterpret_cast<const T*>(inline_);
    }

    bool usingInline() const noexcept {
        return data_ == inlineData();
    }

    static T* allocate(size_t n) {
        if (n == 0) return nullptr;
        return static_cast<T*>(
            ::operator new(n * sizeof(T), std::align_val_t(alignof(T)))
        );
    }

    static void deallocate(T* p) noexcept {
        if (p) {
            ::operator delete(p, std::align_val_t(alignof(T)));
        }
    }

    static void destroyRange(T* p, size_t n) noexcept {
        for (size_t i = 0; i < n; ++i) {
            p[i].~T();
        }
    }

    void destroyCurrent() noexcept {
        destroyRange(data_, size_);
        size_ = 0;
    }

    void grow(size_t minCap) {
        size_t newCap = cap_ == 0 ? 1 : cap_ * 2;
        if (newCap < minCap) newCap = minCap;

        T* nd = allocate(newCap);
        size_t constructed = 0;

        try {
            for (; constructed < size_; ++constructed) {
                new (nd + constructed) T(std::move_if_noexcept(data_[constructed]));
            }
        } catch (...) {
            destroyRange(nd, constructed);
            deallocate(nd);
            throw;
        }

        destroyRange(data_, size_);

        if (!usingInline()) {
            deallocate(data_);
        }

        data_ = nd;
        cap_ = newCap;
    }

    template<typename U>
    T* insertOne(size_t off, U&& value) {
        SmallVector tmp;
        tmp.reserve(size_ + 1);

        for (size_t i = 0; i < off; ++i) {
            tmp.emplace_back(std::move_if_noexcept(data_[i]));
        }

        tmp.emplace_back(std::forward<U>(value));

        for (size_t i = off; i < size_; ++i) {
            tmp.emplace_back(std::move_if_noexcept(data_[i]));
        }

        *this = std::move(tmp);
        return data_ + off;
    }

public:
    SmallVector() noexcept = default;

    ~SmallVector() {
        destroyCurrent();

        if (!usingInline()) {
            deallocate(data_);
        }
    }

    SmallVector(const SmallVector& o) : data_(inlineData()), size_(0), cap_(N) {
        reserve(o.size_);

        size_t constructed = 0;
        try {
            for (; constructed < o.size_; ++constructed) {
                new (data_ + constructed) T(o.data_[constructed]);
            }
            size_ = o.size_;
        } catch (...) {
            destroyRange(data_, constructed);
            size_ = 0;
            throw;
        }
    }

    SmallVector& operator=(const SmallVector& o) {
        if (this == &o) return *this;

        if (o.size_ > cap_) {
            T* nd = allocate(o.size_);
            size_t constructed = 0;

            try {
                for (; constructed < o.size_; ++constructed) {
                    new (nd + constructed) T(o.data_[constructed]);
                }
            } catch (...) {
                destroyRange(nd, constructed);
                deallocate(nd);
                throw;
            }

            destroyCurrent();

            if (!usingInline()) {
                deallocate(data_);
            }

            data_ = nd;
            size_ = o.size_;
            cap_ = o.size_;
            return *this;
        }

        destroyCurrent();

        size_t constructed = 0;
        try {
            for (; constructed < o.size_; ++constructed) {
                new (data_ + constructed) T(o.data_[constructed]);
            }
            size_ = o.size_;
        } catch (...) {
            destroyRange(data_, constructed);
            size_ = 0;
            throw;
        }

        return *this;
    }

    SmallVector(SmallVector&& o)
        noexcept(std::is_nothrow_move_constructible_v<T>)
        : data_(inlineData()), size_(0), cap_(N) {
        if (!o.usingInline()) {
            data_ = o.data_;
            size_ = o.size_;
            cap_ = o.cap_;

            o.data_ = o.inlineData();
            o.size_ = 0;
            o.cap_ = N;
            return;
        }

        reserve(o.size_);

        size_t constructed = 0;
        try {
            for (; constructed < o.size_; ++constructed) {
                new (data_ + constructed) T(std::move(o.data_[constructed]));
            }
            size_ = o.size_;
        } catch (...) {
            destroyRange(data_, constructed);
            size_ = 0;
            throw;
        }

        o.destroyCurrent();
    }

    SmallVector& operator=(SmallVector&& o)
        noexcept(std::is_nothrow_move_constructible_v<T>) {
        if (this == &o) return *this;

        destroyCurrent();

        if (!usingInline()) {
            deallocate(data_);
            data_ = inlineData();
            cap_ = N;
        }

        if (!o.usingInline()) {
            data_ = o.data_;
            size_ = o.size_;
            cap_ = o.cap_;

            o.data_ = o.inlineData();
            o.size_ = 0;
            o.cap_ = N;
            return *this;
        }

        reserve(o.size_);

        size_t constructed = 0;
        try {
            for (; constructed < o.size_; ++constructed) {
                new (data_ + constructed) T(std::move(o.data_[constructed]));
            }
            size_ = o.size_;
        } catch (...) {
            destroyRange(data_, constructed);
            size_ = 0;
            throw;
        }

        o.destroyCurrent();
        return *this;
    }

    SmallVector(std::initializer_list<T> il)
        : data_(inlineData()), size_(0), cap_(N) {
        reserve(il.size());

        try {
            for (const auto& e : il) {
                new (data_ + size_) T(e);
                ++size_;
            }
        } catch (...) {
            destroyCurrent();
            throw;
        }
    }

    SmallVector& operator=(std::initializer_list<T> il) {
        clear();
        reserve(il.size());

        try {
            for (const auto& e : il) {
                new (data_ + size_) T(e);
                ++size_;
            }
        } catch (...) {
            destroyCurrent();
            throw;
        }

        return *this;
    }

    T* begin() noexcept { return data_; }
    T* end() noexcept { return data_ + size_; }

    const T* begin() const noexcept { return data_; }
    const T* end() const noexcept { return data_ + size_; }

    const T* cbegin() const noexcept { return data_; }
    const T* cend() const noexcept { return data_ + size_; }

    size_t size() const noexcept { return size_; }
    bool empty() const noexcept { return size_ == 0; }
    size_t capacity() const noexcept { return cap_; }

    void reserve(size_t n) {
        if (n > cap_) {
            grow(n);
        }
    }

    T& operator[](size_t i) noexcept { return data_[i]; }
    const T& operator[](size_t i) const noexcept { return data_[i]; }

    T& front() noexcept { return data_[0]; }
    const T& front() const noexcept { return data_[0]; }

    T& back() noexcept { return data_[size_ - 1]; }
    const T& back() const noexcept { return data_[size_ - 1]; }

    T* data() noexcept { return data_; }
    const T* data() const noexcept { return data_; }

    void push_back(const T& v) {
        if (size_ >= cap_) {
            grow(size_ + 1);
        }

        new (data_ + size_) T(v);
        ++size_;
    }

    void push_back(T&& v) {
        if (size_ >= cap_) {
            grow(size_ + 1);
        }

        new (data_ + size_) T(std::move(v));
        ++size_;
    }

    template<typename... Args>
    T& emplace_back(Args&&... args) {
        if (size_ >= cap_) {
            grow(size_ + 1);
        }

        new (data_ + size_) T(std::forward<Args>(args)...);
        ++size_;
        return data_[size_ - 1];
    }

    void pop_back() noexcept {
        --size_;
        data_[size_].~T();
    }

    void clear() noexcept {
        destroyCurrent();
    }

    void resize(size_t n) {
        if (n < size_) {
            for (size_t i = n; i < size_; ++i) {
                data_[i].~T();
            }
            size_ = n;
            return;
        }

        if (n > size_) {
            reserve(n);

            size_t constructed = size_;
            try {
                for (; constructed < n; ++constructed) {
                    new (data_ + constructed) T();
                }
                size_ = n;
            } catch (...) {
                destroyRange(data_ + size_, constructed - size_);
                throw;
            }
        }
    }

    T* erase(T* pos) {
        size_t off = static_cast<size_t>(pos - data_);

        pos->~T();

        for (size_t i = off; i + 1 < size_; ++i) {
            new (data_ + i) T(std::move_if_noexcept(data_[i + 1]));
            data_[i + 1].~T();
        }

        --size_;
        return data_ + off;
    }

    T* insert(T* pos, const T& val) {
        size_t off = static_cast<size_t>(pos - data_);

        // Copy first so inserting an element already inside this vector is safe.
        T copy(val);
        return insertOne(off, std::move(copy));
    }

    template<typename InputIt>
    T* insert(T* pos, InputIt first, InputIt last) {
        size_t off = static_cast<size_t>(pos - data_);

        SmallVector tmpValues;
        for (; first != last; ++first) {
            tmpValues.emplace_back(*first);
        }

        if (tmpValues.empty()) {
            return data_ + off;
        }

        SmallVector rebuilt;
        rebuilt.reserve(size_ + tmpValues.size_);

        for (size_t i = 0; i < off; ++i) {
            rebuilt.emplace_back(std::move_if_noexcept(data_[i]));
        }

        for (size_t i = 0; i < tmpValues.size(); ++i) {
            rebuilt.emplace_back(std::move_if_noexcept(tmpValues[i]));
        }

        for (size_t i = off; i < size_; ++i) {
            rebuilt.emplace_back(std::move_if_noexcept(data_[i]));
        }

        *this = std::move(rebuilt);
        return data_ + off;
    }
};
