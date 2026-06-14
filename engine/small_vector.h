#pragma once

#include <cstddef>
#include <cstring>
#include <initializer_list>
#include <new>
#include <type_traits>
#include <utility>

// SmallVector<T, N> — stack-allocated vector with heap overflow, for
// trivially-copyable element types only (everything this engine stores:
// pointers, enums, structs of doubles). The constraint lets growth and
// copies be memcpy and removes all exception-safety scaffolding.
// API subset: push_back, emplace_back, begin/end, insert, erase,
// resize, reserve, size/empty/clear, operator[], copy/move semantics.
template<typename T, size_t N>
class SmallVector {
    static_assert(std::is_trivially_copyable_v<T>,
                  "SmallVector is memcpy-based; use std::vector for non-trivial types");

    alignas(T) unsigned char inline_[sizeof(T) * (N == 0 ? 1 : N)];
    T* data_ = inlineData();
    size_t size_ = 0;
    size_t cap_ = N;

    T* inlineData() noexcept { return reinterpret_cast<T*>(inline_); }
    const T* inlineData() const noexcept { return reinterpret_cast<const T*>(inline_); }
    bool usingInline() const noexcept { return data_ == inlineData(); }

    static T* allocate(size_t n) {
        return static_cast<T*>(::operator new(n * sizeof(T), std::align_val_t(alignof(T))));
    }
    static void deallocate(T* p) noexcept {
        if (p) ::operator delete(p, std::align_val_t(alignof(T)));
    }

    void grow(size_t minCap) {
        size_t newCap = cap_ == 0 ? 1 : cap_ * 2;
        if (newCap < minCap) newCap = minCap;
        T* nd = allocate(newCap);
        if (size_) std::memcpy(static_cast<void*>(nd), data_, size_ * sizeof(T));
        if (!usingInline()) deallocate(data_);
        data_ = nd;
        cap_ = newCap;
    }

public:
    SmallVector() noexcept = default;

    ~SmallVector() {
        if (!usingInline()) deallocate(data_);
    }

    SmallVector(const SmallVector& o) {
        reserve(o.size_);
        if (o.size_) std::memcpy(static_cast<void*>(data_), o.data_, o.size_ * sizeof(T));
        size_ = o.size_;
    }

    SmallVector& operator=(const SmallVector& o) {
        if (this == &o) return *this;
        reserve(o.size_);
        if (o.size_) std::memcpy(static_cast<void*>(data_), o.data_, o.size_ * sizeof(T));
        size_ = o.size_;
        return *this;
    }

    SmallVector(SmallVector&& o) noexcept {
        if (!o.usingInline()) {
            data_ = o.data_; size_ = o.size_; cap_ = o.cap_;
            o.data_ = o.inlineData(); o.size_ = 0; o.cap_ = N;
            return;
        }
        if (o.size_) std::memcpy(static_cast<void*>(data_), o.data_, o.size_ * sizeof(T));
        size_ = o.size_;
        o.size_ = 0;
    }

    SmallVector& operator=(SmallVector&& o) noexcept {
        if (this == &o) return *this;
        if (!usingInline()) {
            deallocate(data_);
            data_ = inlineData();
            cap_ = N;
        }
        size_ = 0;
        if (!o.usingInline()) {
            data_ = o.data_; size_ = o.size_; cap_ = o.cap_;
            o.data_ = o.inlineData(); o.size_ = 0; o.cap_ = N;
            return *this;
        }
        if (o.size_) std::memcpy(static_cast<void*>(data_), o.data_, o.size_ * sizeof(T));
        size_ = o.size_;
        o.size_ = 0;
        return *this;
    }

    SmallVector(std::initializer_list<T> il) {
        reserve(il.size());
        for (const auto& e : il) data_[size_++] = e;
    }

    SmallVector& operator=(std::initializer_list<T> il) {
        size_ = 0;
        reserve(il.size());
        for (const auto& e : il) data_[size_++] = e;
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
        if (n > cap_) grow(n);
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
        if (size_ >= cap_) grow(size_ + 1);
        data_[size_++] = v;
    }

    template<typename... Args>
    T& emplace_back(Args&&... args) {
        if (size_ >= cap_) grow(size_ + 1);
        new (data_ + size_) T(std::forward<Args>(args)...);
        return data_[size_++];
    }

    void pop_back() noexcept { --size_; }
    void clear() noexcept { size_ = 0; }

    void resize(size_t n) {
        if (n > size_) {
            reserve(n);
            for (size_t i = size_; i < n; ++i) new (data_ + i) T();
        }
        size_ = n;
    }

    T* erase(T* pos) {
        size_t off = static_cast<size_t>(pos - data_);
        if (off + 1 < size_) {
            std::memmove(static_cast<void*>(data_ + off), data_ + off + 1,
                         (size_ - off - 1) * sizeof(T));
        }
        --size_;
        return data_ + off;
    }

    T* insert(T* pos, const T& val) {
        size_t off = static_cast<size_t>(pos - data_);
        T copy(val); // value may alias an element about to be shifted
        if (size_ >= cap_) grow(size_ + 1);
        if (off < size_) {
            std::memmove(static_cast<void*>(data_ + off + 1), data_ + off,
                         (size_ - off) * sizeof(T));
        }
        data_[off] = copy;
        ++size_;
        return data_ + off;
    }

    template<typename InputIt>
    T* insert(T* pos, InputIt first, InputIt last) {
        size_t start = static_cast<size_t>(pos - data_); // pos dangles after growth
        size_t off = start;
        for (; first != last; ++first, ++off) {
            insert(data_ + off, *first);
        }
        return data_ + start;
    }
};
